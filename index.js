require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: [
      "http://localhost:5173", // Your Local Frontend
      "https://vein-client.vercel.app", // Your Vercel Link (Add this later)
    ],
    credentials: true,
  })
);
app.use(express.json());

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
    await client.connect();

    const db = client.db("vein");
    const usersCollection = db.collection("users");
    const requestsCollection = db.collection("donationRequests");

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

    // 3. Get Specific Request Details API
    app.get("/donation-requests/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await requestsCollection.findOne(query);
      res.send(result);
    });

    // 4. Create Donation Request API
    app.post("/donation-requests", async (req, res) => {
      const request = req.body;

      // Force status to pending regardless of what is sent
      const newRequest = {
        ...request,
        donationStatus: "pending",
        createdAt: new Date(),
      };

      const result = await requestsCollection.insertOne(newRequest);
      res.send(result);
    });

    // 5. Search Donors API (Public)
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

    // 6. Update Donation Status (Donate Button Action)
    app.patch("/donation-requests/:id", async (req, res) => {
      const id = req.params.id;
      const body = req.body;
      const query = { _id: new ObjectId(id) };

      const updateDoc = {
        $set: {
          donationStatus: "inprogress",
          donorName: body.donorName,
          donorEmail: body.donorEmail,
        },
      };

      const result = await requestsCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    // === Ping MongoDB ===
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
