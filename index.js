require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const cookieParser = require("cookie-parser");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.set("trust proxy", 1);
app.use(
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "https://vein-client.vercel.app",
    ],
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// JWT
const verifyToken = (req, res, next) => {
  const token = req.cookies?.token;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  // Verify the token
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

// MongoDB URI
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set in .env");
  process.exit(1);
}

// MongoDB Client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Test route
app.get("/", (req, res) => {
  res.send("Vein API is running!");
});

async function run() {
  try {
    // Connect to MongoDB
    // await client.connect();

    const db = client.db("vein");
    const usersCollection = db.collection("users");
    const requestsCollection = db.collection("donationRequests");
    const fundingCollection = db.collection("fundings");

    // ================= JWT AUTH ROUTES ================= //

    // ============ for live link ============ //
    // // Generate JWT Token (Login)
    // Generate JWT Token (Login)
    app.post("/jwt", async (req, res) => {
      const userInfo = req.body;
      const token = jwt.sign(userInfo, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "1h",
      });

      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
          maxAge: 3600000,
        })
        .send({ success: true });
    });

    // Logout (Clear Token)
    app.post("/logout", (req, res) => {
      res
        .clearCookie("token", {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
          maxAge: 0,
        })
        .send({ success: true });
    });

    // ================= ROUTES ================= //

    // 1. POST User (Registration)
    app.post("/users", async (req, res) => {
      const newUser = req.body;
      const query = { email: newUser.email };
      const existingUser = await usersCollection.findOne(query);

      if (existingUser) {
        return res.send({ message: "User already exists", insertedId: null });
      }

      // Enforce default fields
      const userToSave = {
        ...newUser,
        role: "donor",
        status: "active",
        createdAt: new Date(),
      };

      const result = await usersCollection.insertOne(userToSave);
      res.send(result);
    });

    // 2. GET All Requests (Public)
    app.get("/donation-requests", async (req, res) => {
      const result = await requestsCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // 3. Create Donation Request API
    app.post("/donation-requests", async (req, res) => {
      const request = req.body;

      // Force status to pending regardless of what is sent
      const newRequest = {
        ...request,
        donationStatus: "pending",
        createdAt: new Date(),
      };

      const result = await requestsCollection.insertOne(newRequest);

      // --- Automatic Notification Trigger: New Request ---
      try {
        // Find Matching Donors + Admins
        const recipients = await usersCollection
          .find({
            $or: [
              // 1. Matching Donors (Same Blood Group + Same District)
              {
                role: "donor",
                status: "active",
                bloodGroup: newRequest.bloodGroup,
                district: newRequest.recipientDistrict,
              },
              // 2. Admins (Always receive all requests)
              { role: "admin" },
            ],
          })
          .toArray();

        if (recipients.length > 0) {
          const notifications = recipients.map((user) => ({
            email: user.email,
            message: `New ${newRequest.bloodGroup} blood request in ${newRequest.recipientDistrict}!`,
            link: `/donation-requests/${result.insertedId}`,
            isRead: false,
            createdAt: new Date(),
          }));

          await notificationsCollection.insertMany(notifications);
        }
      } catch (err) {
        console.error("Failed to send new request notifications:", err);
      }
      // ---------------------------------------------------

      res.send(result);
    });

    // 4. Search Donors API (Public)
    app.get("/donors", async (req, res) => {
      const { bloodGroup, district, upazila } = req.query;

      // Base Query: Only show active donors
      let query = { role: "donor", status: "active" };

      // Add filters if provided
      if (bloodGroup) query.bloodGroup = bloodGroup;
      if (district) query.district = district;
      if (upazila) query.upazila = upazila;

      const result = await usersCollection
        .find(query, {
          projection: { password: 0 },
        })
        .toArray();

      res.send(result);
    });

    // ----------------------------------------------------------------- //

    // 5. Update Donation Request
    app.patch("/donation-requests/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const body = req.body;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: { ...body },
      };
      // Remove _id to avoid modification error
      delete updateDoc.$set._id;

      const result = await requestsCollection.updateOne(query, updateDoc);

      // --- Automatic Notification Trigger: Status Change ---
      // Notify the requester when status changes (e.g. to "inprogress" or "done")
      try {
        if (body.donationStatus) {
          const request = await requestsCollection.findOne(query);
          if (request) {
            const notification = {
              email: request.requesterEmail,
              message: `Your blood request status has updated to: ${body.donationStatus}`,
              isRead: false,
              createdAt: new Date(),
            };
            await notificationsCollection.insertOne(notification);
          }
        }
      } catch (err) {
        console.error("Failed to send status update notification:", err);
      }
      // ---------------------------------------------------

      res.send(result);
    });

    // 6. Update User Profile
    app.patch("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };

      const updateDoc = {
        $set: {
          ...user,
          role: undefined,
          email: undefined,
        },
      };

      // Clean undefined fields
      Object.keys(updateDoc.$set).forEach(
        (key) =>
          updateDoc.$set[key] === undefined && delete updateDoc.$set[key],
      );

      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // ----------------------------------------------------------------- //

    // 7. Get User Role
    app.get("/users/role/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send({ role: result?.role });
    });

    // 8. Get My Donation Requests (Logged-in User Only)
    app.get("/donation-requests/my", verifyToken, async (req, res) => {
      const email = req.query.email;
      const query = { requesterEmail: email };

      // Security: Ensure the token belongs to the requested email
      if (req.user.email !== req.query.email) {
        return res.status(403).send({ message: "forbidden access" });
      }

      const result = await requestsCollection.find(query).toArray();
      res.send(result);
    });

    // 9. Get Specific Request Details API
    app.get("/donation-requests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await requestsCollection.findOne(query);
      res.send(result);
    });

    // 10. Admin Stats (Dashboard Home)
    app.get("/admin-stats", verifyToken, async (req, res) => {
      const users = await usersCollection.estimatedDocumentCount();
      const requests = await requestsCollection.estimatedDocumentCount();

      const fundingData = await fundingCollection
        .aggregate([
          {
            $group: {
              _id: null,
              totalAmount: { $sum: "$amount" },
            },
          },
        ])
        .toArray();

      const funding = fundingData.length > 0 ? fundingData[0].totalAmount : 0;
      res.send({ users, requests, funding });
    });

    // 11. Get All Users (Admin Only)
    app.get("/users", verifyToken, async (req, res) => {
      // Todo: Add verifyAdmin middleware here later
      const result = await usersCollection.find().toArray();
      res.send(result);
    });

    // 12. Update User (Generic for Role & Status)
    app.patch("/users/update/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;
      const filter = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: { ...updateData },
      };

      // Safety: Ensure _id is not in the update document
      delete updateDoc.$set._id;
      const result = await usersCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // 13. Get Specific User (for Role & Blocked Status)
    app.get("/users/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await usersCollection.findOne(query);
      res.send(result);
    });

    // 14. Delete Donation Request
    app.delete("/donation-requests/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await requestsCollection.deleteOne(query);
      res.send(result);
    });

    // ====================== Funding ====================== //
    // 15. Post funding to db
    app.post("/funding", verifyToken, async (req, res) => {
      const funding = req.body;
      const newFunding = {
        ...funding,
        amount: parseFloat(funding.amount),
        createdAt: new Date(),
      };
      const result = await fundingCollection.insertOne(newFunding);

      // --- Automatic Notification Trigger: New Funding ---
      try {
        const admins = await usersCollection.find({ role: "admin" }).toArray();
        if (admins.length > 0) {
          const notifications = admins.map((admin) => ({
            email: admin.email,
            message: `New funding received: $${newFunding.amount}`,
            link: `/dashboard`,
            isRead: false,
            createdAt: new Date(),
          }));
          await notificationsCollection.insertMany(notifications);
        }
      } catch (err) {
        console.error("Failed to send funding notifications:", err);
      }
      // ---------------------------------------------------

      res.send(result);
    });
    // 16. Get All Funding (Admin/Volunteer)
    app.get("/funding", verifyToken, async (req, res) => {
      const result = await fundingCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // ==================== Notifications ==================== //
    const notificationsCollection = db.collection("notifications");

    // Create TTL Index
    await notificationsCollection.createIndex(
      { createdAt: 1 },
      { expireAfterSeconds: 2592000 },
    );

    // 18. POST Notification
    app.post("/notifications", verifyToken, async (req, res) => {
      const notification = req.body;
      const newNotification = {
        ...notification,
        isRead: false,
        createdAt: new Date(),
      };
      const result = await notificationsCollection.insertOne(newNotification);
      res.send(result);
    });

    // 19. GET Notifications (User specific)
    app.get("/notifications", verifyToken, async (req, res) => {
      const email = req.query.email;
      if (req.user.email !== email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = { email: email };
      const result = await notificationsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // 20. Mark Notification as Read
    app.patch("/notifications/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          isRead: true,
        },
      };
      const result = await notificationsCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // 21. Mark ALL Notifications as Read
    app.patch(
      "/notifications/mark-all-read/user",
      verifyToken,
      async (req, res) => {
        const email = req.query.email;

        // Security check
        if (req.user.email !== email) {
          return res.status(403).send({ message: "forbidden access" });
        }

        const filter = { email: email, isRead: false };
        const updateDoc = {
          $set: {
            isRead: true,
          },
        };
        const result = await notificationsCollection.updateMany(
          filter,
          updateDoc,
        );
        res.send(result);
      },
    );

    // ==================== Payment ==================== //
    // 17. Stripe payment API
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const { price } = req.body;

      const amount = parseInt(price * 100);

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // ==================== Ping MongoDB ==================== //
    console.log("Connected to MongoDB! (Vein Database)");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
}
run().catch(console.dir);

// Start server
app.listen(port, () => {
  console.log(`Vein server running on http://localhost:${port}`);
});
