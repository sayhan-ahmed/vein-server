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

const db = client.db("vein");
const usersCollection = db.collection("users");
const requestsCollection = db.collection("donationRequests");
const fundingCollection = db.collection("fundings");
const notificationsCollection = db.collection("notifications");

async function run() {
  try {
    // Connect to MongoDB
    await client.connect();
    console.log("Connected to MongoDB! (Vein Database)");

    // ================== INITIALIZATION ================== //
    try {
      await notificationsCollection.createIndex(
        { createdAt: 1 },
        { expireAfterSeconds: 2592000 },
      );
    } catch (indexError) {
      console.warn("Non-critical initialization warning:", indexError.message);
    }
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}
run().catch(console.dir);

// ================= JWT AUTH ROUTES ================= //

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

// 3. Create Donation Request
app.post("/donation-requests", verifyToken, async (req, res) => {
  const request = req.body;

  // Date Validation: Don't allow past dates
  if (request.donationDate) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const reqDate = new Date(request.donationDate);
    reqDate.setHours(0, 0, 0, 0);

    if (reqDate < today) {
      return res.status(400).send({
        message: "Donation date cannot be in the past.",
      });
    }
  }

  const newRequest = {
    ...request,
    donationStatus: "pending",
    createdAt: new Date(),
  };

  const result = await requestsCollection.insertOne(newRequest);

  // Notifications
  try {
    const recipients = await usersCollection
      .find({
        $or: [
          {
            role: "donor",
            status: "active",
            bloodGroup: newRequest.bloodGroup,
            district: newRequest.recipientDistrict,
          },
          { role: "admin" },
          { role: "volunteer" },
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

  res.send(result);
});

// 4. Search Donors
app.get("/donors", async (req, res) => {
  const { bloodGroup, district, upazila } = req.query;
  let query = { role: "donor", status: "active" };
  if (bloodGroup) query.bloodGroup = bloodGroup;
  if (district) query.district = district;
  if (upazila) query.upazila = upazila;

  const result = await usersCollection
    .find(query, { projection: { password: 0 } })
    .toArray();

  res.send(result);
});

// 5. Update Donation Request
app.patch("/donation-requests/:id", verifyToken, async (req, res) => {
  const id = req.params.id;
  const body = req.body;
  const query = { _id: new ObjectId(id) };

  const updateDoc = { $set: { ...body } };
  delete updateDoc.$set._id;

  const result = await requestsCollection.updateOne(query, updateDoc);

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

  Object.keys(updateDoc.$set).forEach(
    (key) => updateDoc.$set[key] === undefined && delete updateDoc.$set[key],
  );

  const result = await usersCollection.updateOne(query, updateDoc);
  res.send(result);
});

// ================== MIDDLEWARE ================== //
const verifyAdmin = async (req, res, next) => {
  const email = req.user.email;
  const query = { email: email };
  const user = await usersCollection.findOne(query);
  const isAdmin = user?.role === "admin";
  if (!isAdmin) {
    return res.status(403).send({ message: "forbidden access" });
  }
  next();
};

const verifyVolunteer = async (req, res, next) => {
  const email = req.user.email;
  const query = { email: email };
  const user = await usersCollection.findOne(query);
  const isVolunteer = user?.role === "volunteer" || user?.role === "admin";
  if (!isVolunteer) {
    return res.status(403).send({ message: "forbidden access" });
  }
  next();
};

// ================== PUBLIC ROUTES ================== //
app.get("/", (req, res) => {
  res.send("Vein API is running!");
});

// 7. Get User Role
app.get("/users/role/:email", verifyToken, async (req, res) => {
  const email = req.params.email;
  const result = await usersCollection.findOne({ email });
  res.send({ role: result?.role });
});

// 8. Get My Donation Requests
app.get("/donation-requests/my", verifyToken, async (req, res) => {
  const email = req.query.email;
  if (req.user.email !== email) {
    return res.status(403).send({ message: "forbidden access" });
  }
  const query = { requesterEmail: email };
  const result = await requestsCollection.find(query).toArray();
  res.send(result);
});

// 9. Get Specific Request
app.get("/donation-requests/:id", async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await requestsCollection.findOne(query);
  res.send(result);
});

// 10. Admin Stats
app.get("/admin-stats", verifyToken, verifyVolunteer, async (req, res) => {
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

// 11. Get All Users (Admin/Volunteer for Stats)
app.get("/users", verifyToken, verifyVolunteer, async (req, res) => {
  const result = await usersCollection.find().toArray();
  res.send(result);
});

// 12. Update User (Role/Status)
app.patch("/users/update/:id", verifyToken, verifyAdmin, async (req, res) => {
  const id = req.params.id;
  const updateData = req.body;
  const filter = { _id: new ObjectId(id) };

  const updateDoc = { $set: { ...updateData } };
  delete updateDoc.$set._id;

  const result = await usersCollection.updateOne(filter, updateDoc);
  res.send(result);
});

// 13. Get Specific User
app.get("/users/:email", verifyToken, async (req, res) => {
  const email = req.params.email;
  const result = await usersCollection.findOne({ email });
  res.send(result);
});

// 14. Delete Donation Request
app.delete("/donation-requests/:id", verifyToken, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) };
  const result = await requestsCollection.deleteOne(query);
  res.send(result);
});

// 15. POST Funding
app.post("/funding", verifyToken, async (req, res) => {
  const funding = req.body;
  const newFunding = {
    ...funding,
    amount: parseFloat(funding.amount),
    createdAt: new Date(),
  };
  const result = await fundingCollection.insertOne(newFunding);

  try {
    const adminsAndVolunteers = await usersCollection
      .find({ role: { $in: ["admin", "volunteer"] } })
      .toArray();
    if (adminsAndVolunteers.length > 0) {
      const notifications = adminsAndVolunteers.map((user) => ({
        email: user.email,
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

  res.send(result);
});

// 16. GET All Funding
app.get("/funding", verifyToken, verifyVolunteer, async (req, res) => {
  const result = await fundingCollection
    .find()
    .sort({ createdAt: -1 })
    .toArray();
  res.send(result);
});

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

// 19. GET Notifications
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

// 20. Notification Mark Read
app.patch("/notifications/:id", verifyToken, async (req, res) => {
  const id = req.params.id;
  const filter = { _id: new ObjectId(id) };
  const result = await notificationsCollection.updateOne(filter, {
    $set: { isRead: true },
  });
  res.send(result);
});

// 21. Notification Mark All Read for User
app.patch(
  "/notifications/mark-all-read/user",
  verifyToken,
  async (req, res) => {
    const email = req.query.email;
    if (req.user.email !== email) {
      return res.status(403).send({ message: "forbidden access" });
    }
    const query = { email: email };
    const result = await notificationsCollection.updateMany(query, {
      $set: { isRead: true },
    });
    res.send(result);
  },
);

// 21. Stripe
app.post("/create-payment-intent", verifyToken, async (req, res) => {
  const { price } = req.body;
  const amount = parseInt(price * 100);
  const paymentIntent = await stripe.paymentIntents.create({
    amount,
    currency: "usd",
    payment_method_types: ["card"],
  });
  res.send({ clientSecret: paymentIntent.client_secret });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);
  res.status(500).send({ message: err.message });
});

app.listen(port, () => {
  console.log(`Vein server running on http://localhost:${port}`);
});

module.exports = app;
