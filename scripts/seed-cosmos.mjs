#!/usr/bin/env node

/**
 * Seed Cosmos DB with test companies data
 * Usage: node scripts/seed-cosmos.mjs
 */

import { CosmosClient } from "@azure/cosmos";

const COSMOS_ENDPOINT = process.env.COSMOS_DB_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_DB_KEY;
const DATABASE_ID = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const CONTAINER_ID = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

const TEST_COMPANIES = [
  {
    id: "apple-inc",
    company_name: "Apple Inc.",
    industries: ["Electronics", "Technology", "Consumer Electronics"],
    product_keywords: "smartphones, computers, tablets, watches, headphones",
    url: "https://www.apple.com",
    amazon_url: "https://www.amazon.com/s?k=apple",
    logo_url: "/logos/apple.svg",
    headquarters_location: "Cupertino, California, USA",
    hq_lat: 37.3382,
    hq_lng: -122.0086,
    manufacturing_locations: [
      "Shenzhen, China",
      "Shanghai, China",
      "Taipei, Taiwan"
    ],
    manufacturing_geocodes: [
      { city: "Shenzhen", country: "China", lat: 22.5431, lng: 114.0579, formatted_address: "Shenzhen, China" },
      { city: "Shanghai", country: "China", lat: 31.2304, lng: 121.4737, formatted_address: "Shanghai, China" },
      { city: "Taipei", country: "Taiwan", lat: 25.0330, lng: 121.5654, formatted_address: "Taipei, Taiwan" }
    ],
    company_tagline: "Think Different",
    star_score: 4.8,
    star_rating: 4.8,
    confidence_score: 0.96,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "samsung-electronics",
    company_name: "Samsung Electronics",
    industries: ["Electronics", "Technology", "Semiconductor"],
    product_keywords: "smartphones, televisions, refrigerators, washing machines, semiconductors",
    url: "https://www.samsung.com",
    amazon_url: "https://www.amazon.com/s?k=samsung",
    logo_url: "/logos/samsung.svg",
    headquarters_location: "Seoul, South Korea",
    hq_lat: 37.4979,
    hq_lng: 127.0276,
    manufacturing_locations: [
      "Suwon, South Korea",
      "Giheung, South Korea",
      "Kaohsiung, Taiwan"
    ],
    manufacturing_geocodes: [
      { city: "Suwon", country: "South Korea", lat: 37.2636, lng: 127.0084, formatted_address: "Suwon, South Korea" },
      { city: "Giheung", country: "South Korea", lat: 37.2947, lng: 127.1132, formatted_address: "Giheung, South Korea" },
      { city: "Kaohsiung", country: "Taiwan", lat: 22.6171, lng: 120.3014, formatted_address: "Kaohsiung, Taiwan" }
    ],
    company_tagline: "Inspiring Innovation",
    star_score: 4.5,
    star_rating: 4.5,
    confidence_score: 0.92,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "sony-corporation",
    company_name: "Sony Corporation",
    industries: ["Electronics", "Entertainment", "Technology"],
    product_keywords: "cameras, televisions, gaming, audio equipment, semiconductors",
    url: "https://www.sony.com",
    amazon_url: "https://www.amazon.com/s?k=sony",
    logo_url: "/logos/sony.svg",
    headquarters_location: "Tokyo, Japan",
    hq_lat: 35.6762,
    hq_lng: 139.6503,
    manufacturing_locations: [
      "Sendai, Japan",
      "Saitama, Japan",
      "Penang, Malaysia"
    ],
    manufacturing_geocodes: [
      { city: "Sendai", country: "Japan", lat: 38.2688, lng: 140.8720, formatted_address: "Sendai, Japan" },
      { city: "Saitama", country: "Japan", lat: 35.8617, lng: 139.6455, formatted_address: "Saitama, Japan" },
      { city: "Penang", country: "Malaysia", lat: 5.3667, lng: 100.3069, formatted_address: "Penang, Malaysia" }
    ],
    company_tagline: "Make.Believe.",
    star_score: 4.4,
    star_rating: 4.4,
    confidence_score: 0.89,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "nike-inc",
    company_name: "Nike Inc.",
    industries: ["Apparel", "Footwear", "Sports Equipment"],
    product_keywords: "shoes, apparel, athletic wear, sports equipment",
    url: "https://www.nike.com",
    amazon_url: "https://www.amazon.com/s?k=nike",
    logo_url: "/logos/nike.svg",
    headquarters_location: "Beaverton, Oregon, USA",
    hq_lat: 45.5202,
    hq_lng: -122.7702,
    manufacturing_locations: [
      "Jakarta, Indonesia",
      "Hanoi, Vietnam",
      "Taichung, Taiwan"
    ],
    manufacturing_geocodes: [
      { city: "Jakarta", country: "Indonesia", lat: -6.2088, lng: 106.8456, formatted_address: "Jakarta, Indonesia" },
      { city: "Hanoi", country: "Vietnam", lat: 21.0285, lng: 105.8542, formatted_address: "Hanoi, Vietnam" },
      { city: "Taichung", country: "Taiwan", lat: 24.1372, lng: 120.6736, formatted_address: "Taichung, Taiwan" }
    ],
    company_tagline: "Just Do It",
    star_score: 4.3,
    star_rating: 4.3,
    confidence_score: 0.87,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "amazon-com",
    company_name: "Amazon.com Inc.",
    industries: ["E-commerce", "Cloud Computing", "Technology"],
    product_keywords: "online retail, cloud services, web hosting, marketplace",
    url: "https://www.amazon.com",
    amazon_url: "https://www.amazon.com",
    logo_url: "/logos/amazon.svg",
    headquarters_location: "Seattle, Washington, USA",
    hq_lat: 47.6205,
    hq_lng: -122.3493,
    manufacturing_locations: [
      "Seattle, Washington, USA",
      "Arlington, Virginia, USA",
      "Dublin, Ireland"
    ],
    manufacturing_geocodes: [
      { city: "Seattle", country: "USA", lat: 47.6062, lng: -122.3321, formatted_address: "Seattle, Washington, USA" },
      { city: "Arlington", country: "USA", lat: 38.8816, lng: -77.1043, formatted_address: "Arlington, Virginia, USA" },
      { city: "Dublin", country: "Ireland", lat: 53.3498, lng: -6.2603, formatted_address: "Dublin, Ireland" }
    ],
    company_tagline: "Work Hard. Have Fun. Make History.",
    star_score: 4.2,
    star_rating: 4.2,
    confidence_score: 0.91,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "microsoft-corp",
    company_name: "Microsoft Corporation",
    industries: ["Software", "Cloud Computing", "Technology"],
    product_keywords: "operating systems, productivity software, cloud services, gaming",
    url: "https://www.microsoft.com",
    amazon_url: "https://www.amazon.com/s?k=microsoft",
    logo_url: "/logos/microsoft.svg",
    headquarters_location: "Redmond, Washington, USA",
    hq_lat: 47.6740,
    hq_lng: -122.1215,
    manufacturing_locations: [
      "Redmond, Washington, USA",
      "Dublin, Ireland",
      "Mountain View, California, USA"
    ],
    manufacturing_geocodes: [
      { city: "Redmond", country: "USA", lat: 47.6740, lng: -122.1215, formatted_address: "Redmond, Washington, USA" },
      { city: "Dublin", country: "Ireland", lat: 53.3498, lng: -6.2603, formatted_address: "Dublin, Ireland" },
      { city: "Mountain View", country: "USA", lat: 37.3854, lng: -122.0848, formatted_address: "Mountain View, California, USA" }
    ],
    company_tagline: "Empower Every Person and Organization",
    star_score: 4.6,
    star_rating: 4.6,
    confidence_score: 0.94,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "google-llc",
    company_name: "Google LLC",
    industries: ["Technology", "Search", "Advertising"],
    product_keywords: "search engine, cloud services, analytics, advertising platform",
    url: "https://www.google.com",
    amazon_url: "https://www.amazon.com/s?k=google",
    logo_url: "/logos/google.svg",
    headquarters_location: "Mountain View, California, USA",
    hq_lat: 37.4220,
    hq_lng: -122.0841,
    manufacturing_locations: [
      "Mountain View, California, USA",
      "Sunnyvale, California, USA",
      "London, United Kingdom"
    ],
    manufacturing_geocodes: [
      { city: "Mountain View", country: "USA", lat: 37.3854, lng: -122.0848, formatted_address: "Mountain View, California, USA" },
      { city: "Sunnyvale", country: "USA", lat: 37.3688, lng: -122.0363, formatted_address: "Sunnyvale, California, USA" },
      { city: "London", country: "United Kingdom", lat: 51.5074, lng: -0.1278, formatted_address: "London, United Kingdom" }
    ],
    company_tagline: "Do No Evil",
    star_score: 4.7,
    star_rating: 4.7,
    confidence_score: 0.96,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "intel-corp",
    company_name: "Intel Corporation",
    industries: ["Semiconductors", "Electronics", "Technology"],
    product_keywords: "microprocessors, computer chips, data center hardware",
    url: "https://www.intel.com",
    amazon_url: "https://www.amazon.com/s?k=intel",
    logo_url: "/logos/intel.svg",
    headquarters_location: "Santa Clara, California, USA",
    hq_lat: 37.3860,
    hq_lng: -122.0288,
    manufacturing_locations: [
      "Santa Clara, California, USA",
      "Chandler, Arizona, USA",
      "Fab 30 Korea"
    ],
    manufacturing_geocodes: [
      { city: "Santa Clara", country: "USA", lat: 37.3860, lng: -122.0288, formatted_address: "Santa Clara, California, USA" },
      { city: "Chandler", country: "USA", lat: 33.3062, lng: -111.8413, formatted_address: "Chandler, Arizona, USA" },
      { city: "Icheon", country: "South Korea", lat: 37.2756, lng: 127.1080, formatted_address: "Icheon, South Korea" }
    ],
    company_tagline: "Experience Amazing",
    star_score: 4.1,
    star_rating: 4.1,
    confidence_score: 0.85,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  },
  {
    id: "tesla-inc",
    company_name: "Tesla Inc.",
    industries: ["Automotive", "Energy", "Technology"],
    product_keywords: "electric vehicles, batteries, energy storage, solar panels",
    url: "https://www.tesla.com",
    amazon_url: "https://www.amazon.com/s?k=tesla",
    logo_url: "/logos/tesla.svg",
    headquarters_location: "Austin, Texas, USA",
    hq_lat: 30.2672,
    hq_lng: -97.7431,
    manufacturing_locations: [
      "Austin, Texas, USA",
      "Fremont, California, USA",
      "Shanghai, China"
    ],
    manufacturing_geocodes: [
      { city: "Austin", country: "USA", lat: 30.2672, lng: -97.7431, formatted_address: "Austin, Texas, USA" },
      { city: "Fremont", country: "USA", lat: 37.5485, lng: -121.9886, formatted_address: "Fremont, California, USA" },
      { city: "Shanghai", country: "China", lat: 31.2304, lng: 121.4737, formatted_address: "Shanghai, China" }
    ],
    company_tagline: "Accelerating the World's Transition to Sustainable Energy",
    star_score: 4.4,
    star_rating: 4.4,
    confidence_score: 0.90,
    created_at: new Date().toISOString(),
    session_id: "seed-01"
  }
];

async function seedCosmos() {
  if (!COSMOS_KEY) {
    console.error("❌ COSMOS_DB_KEY is not set. Cannot seed database.");
    process.exit(1);
  }

  const client = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const database = client.database(DATABASE_ID);
  const container = database.container(CONTAINER_ID);

  console.log(`📍 Connecting to Cosmos DB at ${COSMOS_ENDPOINT}`);
  console.log(`📦 Database: ${DATABASE_ID}, Container: ${CONTAINER_ID}`);

  try {
    // Check if container exists
    try {
      await container.read();
      console.log("✓ Container exists");
    } catch (e) {
      console.log("⚠️  Container does not exist. Creating...");
      await database.containers.create({ id: CONTAINER_ID });
    }

    // Seed test data
    let insertedCount = 0;
    for (const company of TEST_COMPANIES) {
      try {
        await container.items.create(company);
        console.log(`✓ Inserted: ${company.company_name}`);
        insertedCount++;
      } catch (e) {
        if (e.code === 409) {
          console.log(`⊘ Already exists: ${company.company_name}`);
        } else {
          console.error(`✗ Error inserting ${company.company_name}:`, e.message);
        }
      }
    }

    console.log(`\n✅ Seed complete! Inserted ${insertedCount}/${TEST_COMPANIES.length} companies.`);
    console.log(`\nYou can now search for: apple, samsung, sony, nike, amazon`);

  } catch (e) {
    console.error("❌ Seeding failed:", e.message);
    process.exit(1);
  }
}

seedCosmos();
