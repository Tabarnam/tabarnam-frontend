import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT || process.env.VITE_COSMOS_ENDPOINT;
const key = process.env.COSMOS_DB_KEY || process.env.VITE_COSMOS_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

const client = new CosmosClient({ endpoint, key });
const database = client.database(databaseId);
const container = database.container(containerId);

const locations = [
  { city: "New York, NY", lat: 40.7128, lng: -74.006 },
  { city: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
  { city: "San Francisco, CA", lat: 37.7749, lng: -122.4194 },
  { city: "Austin, TX", lat: 30.2672, lng: -97.7431 },
  { city: "Seattle, WA", lat: 47.6062, lng: -122.3321 },
  { city: "Denver, CO", lat: 39.7392, lng: -104.9903 },
  { city: "Boston, MA", lat: 42.3601, lng: -71.0589 },
  { city: "Miami, FL", lat: 25.7617, lng: -80.1918 },
  { city: "Chicago, IL", lat: 41.8781, lng: -87.6298 },
  { city: "Portland, OR", lat: 45.5152, lng: -122.6784 },
];

const industries = [
  ["Technology", "Software"],
  ["Manufacturing", "Industrial"],
  ["Retail", "E-commerce"],
  ["Food & Beverage", "Gourmet"],
  ["Health & Wellness", "Supplements"],
  ["IoT", "Smart Home"],
  ["Fitness", "Sports"],
  ["Education", "EdTech"],
  ["Sustainability", "Consumer Goods"],
  ["Luxury", "Retail"],
];

const testCompanies = [];
for (let i = 1; i <= 20; i++) {
  const locationIdx = (i - 1) % locations.length;
  const industriesIdx = (i - 1) % industries.length;
  const baseLocation = locations[locationIdx];
  
  const company = {
    id: `test-company-${i}`,
    company_name: `TEST Company ${i}`,
    name: `TEST Company ${i}`,
    tagline: `Premium service provider for industry segment ${i}`,
    website_url: `https://test-company-${i}.example.com`,
    amazon_store_url: `https://amazon.com/s?k=test+company+${i}`,
    amazon_url: `https://amazon.com/s?k=test+company+${i}`,
    logo_url: `https://via.placeholder.com/150?text=TEST${i}`,
    industries: industries[industriesIdx],
    star_rating: Math.floor(Math.random() * 2) + 3,
    auto_star_rating: Math.floor(Math.random() * 3) + 1,
    notes: `Test company ${i} - Created for review testing. High-quality products and services in ${industries[industriesIdx].join(" / ")}.`,
    contact_email: `contact@test-company-${i}.example.com`,
    contact_page_url: `https://test-company-${i}.example.com/contact`,
    manufacturing_locations: [
      {
        address: `${100 + i} Main St, ${baseLocation.city}`,
        lat: baseLocation.lat + (Math.random() * 0.01 - 0.005),
        lng: baseLocation.lng + (Math.random() * 0.01 - 0.005),
        is_hq: true,
      },
      {
        address: `${200 + i} Secondary Ave, ${locations[(locationIdx + 1) % locations.length].city}`,
        lat: locations[(locationIdx + 1) % locations.length].lat + (Math.random() * 0.01 - 0.005),
        lng: locations[(locationIdx + 1) % locations.length].lng + (Math.random() * 0.01 - 0.005),
        is_hq: false,
      },
    ],
    affiliate_links: [
      {
        url: `https://example.com/test-company-${i}`,
        name: `TEST Company ${i} Direct`,
        description: `Direct retailer for TEST Company ${i} products`,
        notes: `Primary affiliate partner for test company ${i}`,
        is_public: true,
      },
      {
        url: `https://example.com/test-company-${i}-pro`,
        name: `TEST Company ${i} Pro Edition`,
        description: `Professional tier products and services`,
        is_public: true,
      },
    ],
    star_explanation: [
      {
        star_level: 1,
        note: `Excellent headquarters location in ${baseLocation.city}`,
        is_public: true,
      },
      {
        star_level: 2,
        note: `Multiple manufacturing and distribution facilities`,
        is_public: true,
      },
      {
        star_level: 3,
        note: `Strong customer satisfaction and positive reviews`,
        is_public: true,
      },
      {
        star_level: 4,
        note: `Industry-leading innovation and quality standards`,
        is_public: true,
      },
      {
        star_level: 5,
        note: `Exceptional customer service and support`,
        is_public: true,
      },
    ],
    review_count: Math.floor(Math.random() * 100) + 20,
    avg_rating: (Math.random() * 1.5 + 3.5).toFixed(1),
    keywords: [
      `test-keyword-${i}`,
      `quality-${i}`,
      `innovation-${i}`,
      `reliable-${i}`,
      `service-${i}`,
    ],
    red_flag: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  testCompanies.push(company);
}

async function seedTestCompanies() {
  try {
    console.log("🌱 Starting to seed 20 TEST companies...\n");

    let createdCount = 0;
    for (const company of testCompanies) {
      try {
        await container.items.upsert(company);
        console.log(`✓ Seeded: ${company.company_name}`);
        createdCount += 1;
      } catch (e) {
        console.warn(
          `⚠ Failed to seed ${company.company_name}:`,
          e?.message
        );
      }
    }

    console.log(
      `\n✅ Successfully seeded ${createdCount}/${testCompanies.length} TEST companies`
    );
    console.log(`\n📝 To delete all TEST companies later, search for company_name starting with "TEST"`);
  } catch (error) {
    console.error(
      "❌ Error seeding TEST companies:",
      error?.message || error
    );
    process.exit(1);
  }
}

seedTestCompanies();
