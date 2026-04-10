import "dotenv/config";
import express from "express";
import crypto from "crypto";
import { runFullSync, syncAffectedBundles } from "./inventory.js";
import { getVariant } from "./shopify.js";
import { enqueue } from "./queue.js";

const app = express();

// Raw body needed for webhook verification
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Verify Shopify webhook HMAC signature
function verifyWebhook(req) {
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  const hash = crypto
    .createHmac("sha256", secret)
    .update(req.rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac));
}

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "bundle-inventory-sync" });
});

// Manual full sync trigger (protected by SYNC_SECRET)
app.post("/sync", async (req, res) => {
  const secret = req.headers["x-sync-secret"];
  if (secret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.json({ message: "Sync started" });

  // Run async — don't block response
  enqueue(() => runFullSync()).catch((err) =>
    console.error("[sync] Full sync failed:", err.message)
  );
});

// Shopify webhook: inventory_levels/update
app.post("/webhooks/inventory", async (req, res) => {
  if (!verifyWebhook(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  // Acknowledge immediately — Shopify expects fast response
  res.status(200).json({ received: true });

  const { inventory_item_id, location_id, available } = req.body;

  // Ignore updates from the ghost location itself to prevent loops
  if (String(location_id) === String(process.env.GHOST_LOCATION_ID)) {
    console.log("[webhook] Ignoring update from ghost location");
    return;
  }

  console.log(
    `[webhook] inventory_levels/update — item ${inventory_item_id} at location ${location_id} = ${available}`
  );

  try {
    // Get the variant ID from the inventory item ID
    const variantsRes = await fetch(

      `https://${process.env.SHOPIFY_SHOP}/admin/api/2024-01/variants.json?inventory_item_ids=${inventory_item_id}`,
      {
        headers: {
          "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    const variantsData = await variantsRes.json();
    const variant = (variantsData.variants || [])[0];

    if (!variant) {
      console.log(`[webhook] No variant found for inventory item ${inventory_item_id}`);
      return;
    }

    enqueue(() => syncAffectedBundles(String(variant.id))).catch((err) =>
      console.error("[webhook] Sync failed:", err.message)
    );
  } catch (err) {
    console.error("[webhook] Error looking up variant:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[server] Bundle inventory sync running on port ${PORT}`);

  // Run full sync on startup
  enqueue(() => runFullSync()).catch((err) =>
    console.error("[startup] Full sync failed:", err.message)
  );
});
