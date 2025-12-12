require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion } = require("mongodb");

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
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
    const requestsCol = db.collection("donation-requests");

    // === GET all requests (public) ===
    app.get("/donation-requests", async (req, res) => {
      const result = await requestsCol.find().sort({ createdAt: -1 }).toArray();
      res.send(result);
    });

    // ----------------------------------------------------------------- //

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
