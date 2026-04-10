import {
  getAllShoeProducts,
  getVariantMetafields,
  getVariant,
  getVariantBySku,
  getInventoryLevel,
  getFulfillmentLocationIds,
  setGhostInventory,
} from "./shopify.js";

// Parse metafield value — could be a variant ID (numeric) or SKU (string)
function parseMetafieldValue(value) {
  if (!value) return null;
  // Strip quotes if JSON string
  try {
    const parsed = JSON.parse(value);
    return String(parsed).trim();
  } catch {
    return String(value).trim();
  }
}

// Resolve a metafield value to { variantId, inventoryItemId }
async function resolveComponent(value) {
  if (!value) return null;

  // Extract numeric ID from GID format: gid://shopify/ProductVariant/12345 → "12345"
  if (value.startsWith("gid://")) {
    value = value.split("/").pop();
  }

  const isNumeric = /^\d+$/.test(value);

  if (isNumeric) {
    // It's a variant ID
    try {
      const variant = await getVariant(value);
      if (!variant) return null;
      return {
        variantId: String(variant.id),
        inventoryItemId: String(variant.inventory_item_id),
      };
    } catch {
      return null;
    }
  } else {
    // It's a SKU
    const variant = await getVariantBySku(value);
    if (!variant) return null;
    return {
      variantId: String(variant.id),
      inventoryItemId: String(variant.inventory_item_id),
    };
  }
}

// Calculate and update ghost inventory for a single bundle variant
export async function syncBundleVariant(variant, fulfillmentLocationIds) {
  const metafields = await getVariantMetafields(variant.id);

  const topMeta = metafields.find((m) => m.key === "top");
  const bottomMeta = metafields.find((m) => m.key === "bottom");

  if (!topMeta && !bottomMeta) {
    // Not a bundle variant — skip
    return null;
  }

  const topValue = topMeta ? parseMetafieldValue(topMeta.value) : null;
  const bottomValue = bottomMeta ? parseMetafieldValue(bottomMeta.value) : null;

  const [topComponent, bottomComponent] = await Promise.all([
    topValue ? resolveComponent(topValue) : Promise.resolve(null),
    bottomValue ? resolveComponent(bottomValue) : Promise.resolve(null),
  ]);

  if (!topComponent && !bottomComponent) return null;

  // Per-location min: sum of min(top, bottom) at each location independently.
  // This prevents overstating availability when components are at different warehouses.
  let bundleQty = 0;
  for (const locationId of fulfillmentLocationIds) {
    const quantities = [];
    if (topComponent) {
      const qty = await getInventoryLevel(topComponent.inventoryItemId, locationId);
      quantities.push(Math.max(0, qty));
    }
    if (bottomComponent) {
      const qty = await getInventoryLevel(bottomComponent.inventoryItemId, locationId);
      quantities.push(Math.max(0, qty));
    }
    bundleQty += Math.min(...quantities);
  }
  const bundleInventoryItemId = variant.inventory_item_id;

  await setGhostInventory(bundleInventoryItemId, bundleQty);

  return {
    variantId: variant.id,
    top: topValue,
    bottom: bottomValue,
    bundleQty,
    topComponentId: topComponent?.variantId ?? null,
    bottomComponentId: bottomComponent?.variantId ?? null,
  };
}

// Cache: componentVariantId → array of bundle variants that reference it
// Built during full sync, used to make webhook syncs instant
const componentToBundles = new Map();

// Full sync — all SHOES products, all bundle variants
// Also rebuilds the component→bundle cache
export async function runFullSync() {
  console.log("[sync] Starting full sync...");

  const [products, fulfillmentLocationIds] = await Promise.all([
    getAllShoeProducts(),
    getFulfillmentLocationIds(),
  ]);

  console.log(`[sync] Found ${products.length} SHOES products`);
  console.log(`[sync] Fulfillment locations: ${fulfillmentLocationIds.join(", ")}`);

  componentToBundles.clear();

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const product of products) {
    for (const variant of product.variants) {
      try {
        const result = await syncBundleVariant(variant, fulfillmentLocationIds);
        if (result) {
          console.log(
            `[sync] ✓ ${product.title} / variant ${variant.id} → ${result.bundleQty} bundles`
          );
          updated++;

          // Register in cache
          for (const componentId of [result.topComponentId, result.bottomComponentId]) {
            if (!componentId) continue;
            if (!componentToBundles.has(componentId)) componentToBundles.set(componentId, []);
            componentToBundles.get(componentId).push(variant);
          }
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[sync] ✗ Error on variant ${variant.id}:`, err.message);
        errors++;
      }
    }
  }

  console.log(
    `[sync] Done. Updated: ${updated}, Skipped (no bundle metafields): ${skipped}, Errors: ${errors}`
  );
  console.log(`[sync] Cache built: ${componentToBundles.size} component(s) mapped to bundles`);

  return { updated, skipped, errors };
}

// Targeted sync — called from webhook when a component's inventory changes
// Uses cache for instant lookup; falls back to full scan if cache is empty
export async function syncAffectedBundles(componentVariantId) {
  const componentId = String(componentVariantId);
  const fulfillmentLocationIds = await getFulfillmentLocationIds();

  // Fast path: use cache
  if (componentToBundles.size > 0) {
    const bundles = componentToBundles.get(componentId) || [];
    if (bundles.length === 0) {
      console.log(`[webhook] No bundles reference component ${componentId} — skipping`);
      return { updated: 0 };
    }

    console.log(`[webhook] Component ${componentId} affects ${bundles.length} bundle variant(s) — syncing...`);
    let updated = 0;
    for (const variant of bundles) {
      try {
        const result = await syncBundleVariant(variant, fulfillmentLocationIds);
        if (result) {
          console.log(`[webhook] ✓ variant ${variant.id} → ${result.bundleQty} bundles`);
          updated++;
        }
      } catch (err) {
        console.error(`[webhook] ✗ Error on variant ${variant.id}:`, err.message);
      }
    }
    console.log(`[webhook] Done. Updated ${updated} bundle variant(s).`);
    return { updated };
  }

  // Slow path: cache not yet built (first webhook before full sync completes)
  console.log(`[webhook] Cache empty — scanning all products for component ${componentId}...`);
  const products = await getAllShoeProducts();
  let updated = 0;

  for (const product of products) {
    for (const variant of product.variants) {
      try {
        const metafields = await getVariantMetafields(variant.id);
        const topMeta = metafields.find((m) => m.key === "top");
        const bottomMeta = metafields.find((m) => m.key === "bottom");
        if (!topMeta && !bottomMeta) continue;

        const normalizeId = (v) => {
          if (!v) return null;
          let val = parseMetafieldValue(v);
          return val?.startsWith("gid://") ? val.split("/").pop() : val;
        };

        const topId = normalizeId(topMeta?.value);
        const bottomId = normalizeId(bottomMeta?.value);

        if (topId !== componentId && bottomId !== componentId) continue;

        const result = await syncBundleVariant(variant, fulfillmentLocationIds);
        if (result) {
          console.log(`[webhook] ✓ variant ${variant.id} → ${result.bundleQty} bundles`);
          updated++;
        }
      } catch (err) {
        console.error(`[webhook] ✗ Error on variant ${variant.id}:`, err.message);
      }
    }
  }

  console.log(`[webhook] Done. Updated ${updated} bundle variant(s).`);
  return { updated };
}

// Diagnostic: show exactly what inventory is read for each component of a bundle variant
export async function diagnoseBundleVariant(variantId) {
  const fulfillmentLocationIds = await getFulfillmentLocationIds();
  const ghostId = process.env.GHOST_LOCATION_ID;
  const allLocationIds = [...fulfillmentLocationIds, ghostId];

  const metafields = await getVariantMetafields(variantId);
  const topMeta = metafields.find((m) => m.key === "top");
  const bottomMeta = metafields.find((m) => m.key === "bottom");

  const result = {
    variantId,
    ghostLocationId: ghostId,
    fulfillmentLocationIds,
    components: {},
    calculation: [],
    bundleQty: 0,
  };

  for (const [key, meta] of [["top", topMeta], ["bottom", bottomMeta]]) {
    if (!meta) continue;
    const rawValue = parseMetafieldValue(meta.value);
    const component = await resolveComponent(rawValue);
    if (!component) {
      result.components[key] = { raw: rawValue, error: "Could not resolve component" };
      continue;
    }

    const locationInventory = {};
    for (const locId of allLocationIds) {
      const qty = await getInventoryLevel(component.inventoryItemId, locId);
      locationInventory[String(locId)] = qty;
    }
    result.components[key] = {
      raw: rawValue,
      variantId: component.variantId,
      inventoryItemId: component.inventoryItemId,
      inventoryByLocation: locationInventory,
    };
  }

  // Recalculate bundle qty with same logic as syncBundleVariant
  const top = result.components.top;
  const bottom = result.components.bottom;
  let bundleQty = 0;
  for (const locId of fulfillmentLocationIds) {
    const locStr = String(locId);
    const quantities = [];
    if (top?.inventoryByLocation) quantities.push(Math.max(0, top.inventoryByLocation[locStr] ?? 0));
    if (bottom?.inventoryByLocation) quantities.push(Math.max(0, bottom.inventoryByLocation[locStr] ?? 0));
    const locMin = quantities.length ? Math.min(...quantities) : 0;
    result.calculation.push({ locationId: locStr, min: locMin });
    bundleQty += locMin;
  }
  result.bundleQty = bundleQty;
  return result;
}
