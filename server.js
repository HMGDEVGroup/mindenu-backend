import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import admin from "firebase-admin";

dotenv.config();

/* ------------------------------------------------------------------ */
/* Firebase Admin Init                                                  */
/* ------------------------------------------------------------------ */

function initFirebaseAdmin() {
  if (admin.apps.length) return admin;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      "[firebaseAdmin] Missing FIREBASE_SERVICE_ACCOUNT_JSON env var"
    );
  }

  const serviceAccount = JSON.parse(raw);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });

  console.log(
    "[firebaseAdmin] initialized with service account:",
    serviceAccount.project_id
  );
  console.log(
    "[firebaseAdmin] client_email:",
    serviceAccount.client_email
  );

  return admin;
}

const firebaseAdmin = initFirebaseAdmin();

/* ------------------------------------------------------------------ */
/* Express App Setup                                                    */
/* ------------------------------------------------------------------ */

const app = express();

app.use(
  cors({
    origin: "*",
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

app.use(express.json());

/* ------------------------------------------------------------------ */
/* 🔍 AUTH DEBUG MIDDLEWARE (YOUR REQUEST)                              */
/* ------------------------------------------------------------------ */

app.use((req, res, next) => {
  const auth = req.headers.authorization || "";
  console.log(
    `[req] ${req.method} ${req.path} auth=${
      auth ? auth.slice(0, 20) + "..." : "❌ NONE"
    }`
  );
  next();
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function requireAuth(req, res) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      ok: false,
      error: "missing_authorization",
      build: "server.js-v7-add-delete-calendar-events",
    });
    return null;
  }

  const idToken = authHeader.replace("Bearer ", "").trim();

  try {
    const decoded = await firebaseAdmin.auth().verifyIdToken(idToken);
    return decoded;
  } catch (err) {
    console.error("[auth] verifyIdToken failed:", err.message);
    res.status(401).json({
      ok: false,
      error: "invalid_token",
      build: "server.js-v7-add-delete-calendar-events",
    });
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    build: "server.js-v7-add-delete-calendar-events",
  });
});

/* ----------------------------- CHAT -------------------------------- */

app.post("/v1/chat", async (req, res) => {
  const decoded = await requireAuth(req, res);
  if (!decoded) return;

  const { message, messages, uid } = req.body || {};

  // v7 REQUIREMENT: uid must exist (you added this earlier)
  if (!uid) {
    return res.status(400).json({
      ok: false,
      error: "missing_uid",
      build: "server.js-v7-add-delete-calendar-events",
    });
  }

  // v7 REQUIREMENT: message must exist
  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({
      ok: false,
      error: "missing_message",
      build: "server.js-v7-add-delete-calendar-events",
    });
  }

  // ---- Simulated AI response (replace with OpenAI call if needed) ----
  const reply = `You asked: "${message}"`;

  res.json({
    ok: true,
    reply,
    uid,
  });
});

/* ------------------------------------------------------------------ */
/* Start Server                                                        */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `mindenu-api listening on :${PORT} (server.js-v7-add-delete-calendar-events)`
  );
});