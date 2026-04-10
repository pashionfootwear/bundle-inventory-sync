const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const API_VERSION = "2024-01";
const BASE = `https://${SHOP}/admin/api/${API_VERSION}`;

// Throttle: minimum 150ms between API calls (~6-7 req/sec, well under the 20/sec limit)
let lastCallTime = 0;
async function throttle() {
  const now = Date.now();
  const wait = 150 - (now - lastCallTime);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallTime = Date.now();
}

async function shopifyFetch(path, options = {}, retries = 3) {
  await throttle();
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  // Retry on rate limit with backoff
  if (res.status === 429 && retries > 0) {
    const retryAfter = Number(res.headers.get("retry-after") || 2);
    console.warn(`[api] Rate limited — retrying in ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return shopifyFetch(path, options, retries - 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify API error ${res.status} on ${path}: ${text}`);
  }

  return res.json();
}

// Paginate through all products of type SHOES
export async function getAllShoeProducts() {
  const products = [];
  let url = `/products.json?product_type=SHOES&limit=250&fields=id,title,variants`;

  while (url) {
    const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}${url.startsWith("/") ? url : "?" + url}`, {
      headers: {
        "X-Shopify-Access-Token": TOKEN,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Shopify API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    products.push(...(data.products || []));

    // Check Link header for next page
    const link = res.headers.get("link") || "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      const nextUrl = new URL(nextMatch[1]);
      url = nextUrl.pathname.replace(`/admin/api/${API_VERSION}`, "") + nextUrl.search;
    } else {
      url = null;
    }
  }

  return products;
}

// Get metafields for a variant
export async function getVariantMetafields(variantId) {
  const data = await shopifyFetch(`/variants/${variantId}/metafields.json?namespace=bundle`);
  return data.metafields || [];
}

// Get inventory level for a variant at a specific location
export async function getInventoryLevel(inventoryItemId, locationId) {
  const data = await shopifyFetch(
    `/inventory_levels.json?inventory_item_ids=${inventoryItemId}&location_ids=${locationId}`
  );
  const level = (data.inventory_levels || [])[0];
  return level ? level.available : 0;
}

// Get variant by ID (to get inventory_item_id)
export async function getVariant(variantId) {
  const data = await shopifyFetch(`/variants/${variantId}.json`);
  return data.variant;
}

// Find variant by SKU across all products
export async function getVariantBySku(sku) {
  // Search via GraphQL for efficiency
  const query = `
    query {
      productVariants(first: 5, query: "sku:${sku}") {
        edges {
          node {
            id
            sku
            inventoryItem { id legacyResourceId }
            legacyResourceId
          }
        }
      }
    }
  `;

  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });

  const data = await res.json();
  const edges = data?.data?.productVariants?.edges || [];
  if (!edges.length) return null;

  const node = edges[0].node;
  return {
    id: node.legacyResourceId,
    inventory_item_id: node.inventoryItem.legacyResourceId,
  };
}

// Get all active fulfillment location IDs (excludes ghost location)
export async function getFulfillmentLocationIds() {
  const data = await shopifyFetch(`/locations.json?active=true`);
  const ghostId = String(process.env.GHOST_LOCATION_ID);
  return (data.locations || [])
    .filter((l) => String(l.id) !== ghostId)
    .map((l) => l.id);
}

// Set inventory at ghost location
export async function setGhostInventory(inventoryItemId, quantity) {
  const locationId = process.env.GHOST_LOCATION_ID;

  // First connect the inventory item to the ghost location if not already connected
  try {
    await shopifyFetch(`/inventory_levels/connect.json`, {
      method: "POST",
      body: JSON.stringify({
        location_id: locationId,
        inventory_item_id: inventoryItemId,
      }),
    });
  } catch (_) {
    // Already connected — ignore
  }

  await shopifyFetch(`/inventory_levels/set.json`, {
    method: "POST",
    body: JSON.stringify({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: quantity,
    }),
  });
}

// Get inventory item ID from variant ID via API
export async function getInventoryItemId(variantId) {
  const variant = await getVariant(variantId);
  return variant?.inventory_item_id;
}
