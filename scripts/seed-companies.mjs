import { CosmosClient } from "@azure/cosmos";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

const client = new CosmosClient({ endpoint, key });
const database = client.database(databaseId);
const container = database.container(containerId);

const sampleCompanies = [
  {
    id: "test-acme-corp",
    company_name: "ACME Corp",
    name: "ACME Corp",
    tagline: "Leading innovation in industrial solutions",
    website_url: "https://acme.example.com",
    amazon_store_url: "https://amazon.com/s?k=acme",
    amazon_url: "https://amazon.com/s?k=acme",
    logo_url: "https://via.placeholder.com/150?text=ACME",
    product_keywords: "industrial equipment, manufacturing test, heavy machinery",
    normalized_domain: "acme.example.com",
    industries: ["Manufacturing", "Industrial"],
    star_rating: 4,
    auto_star_rating: 3,
    notes: "High-quality manufacturing",
    contact_email: "sales@acme.example.com",
    contact_page_url: "https://acme.example.com/contact",
    manufacturing_locations: [
      { address: "123 Main St, New York, NY", lat: 40.7128, lng: -74.006, is_hq: true },
      { address: "456 Oak Ave, Los Angeles, CA", lat: 34.0522, lng: -118.2437, is_hq: false },
    ],
    manufacturing_geocodes: [
      { address: "123 Main St, New York, NY", lat: 40.7128, lng: -74.006 },
      { address: "456 Oak Ave, Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
    ],
    hq_lat: 40.7128,
    hq_lng: -74.006,
    affiliate_links: [
      {
        url: "https://example.com/acme",
        name: "ACME Direct",
        description: "Direct retailer for ACME products",
        notes: "Primary affiliate partner",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Excellent HQ location", is_public: true },
      { star_level: 2, note: "Multiple manufacturing facilities", is_public: true },
      { star_level: 3, note: "Strong customer reviews", is_public: true },
    ],
    review_count: 45,
    avg_rating: 4.5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-techvision-inc",
    company_name: "TechVision Inc",
    name: "TechVision Inc",
    tagline: "Cutting-edge technology solutions",
    website_url: "https://techvision.example.com",
    amazon_store_url: "https://amazon.com/s?k=techvision",
    amazon_url: "https://amazon.com/s?k=techvision",
    logo_url: "https://via.placeholder.com/150?text=TechVision",
    product_keywords: "software solutions, test automation, tech innovations",
    normalized_domain: "techvision.example.com",
    industries: ["Technology", "Software"],
    star_rating: 5,
    auto_star_rating: 3,
    notes: "Innovation-focused tech company",
    contact_email: "info@techvision.example.com",
    manufacturing_locations: [
      { address: "789 Tech Blvd, San Francisco, CA", lat: 37.7749, lng: -122.4194, is_hq: true },
    ],
    manufacturing_geocodes: [
      { address: "789 Tech Blvd, San Francisco, CA", lat: 37.7749, lng: -122.4194 },
    ],
    hq_lat: 37.7749,
    hq_lng: -122.4194,
    affiliate_links: [
      {
        url: "https://example.com/techvision",
        name: "TechVision Store",
        description: "Official TechVision retailer",
        is_public: true,
      },
      {
        url: "https://example.com/techvision-pro",
        name: "Pro Edition",
        description: "Professional tech suite",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Headquarters in innovation hub", is_public: true },
      { star_level: 4, note: "Award-winning technology", is_public: true },
      { star_level: 5, note: "Industry leader", is_public: true },
    ],
    review_count: 120,
    avg_rating: 4.8,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-ecogreen-products",
    company_name: "EcoGreen Products",
    name: "EcoGreen Products",
    tagline: "Sustainable and eco-friendly solutions",
    website_url: "https://ecogreen.example.com",
    amazon_store_url: "https://amazon.com/s?k=ecogreen",
    amazon_url: "https://amazon.com/s?k=ecogreen",
    logo_url: "https://via.placeholder.com/150?text=EcoGreen",
    product_keywords: "eco-friendly products, sustainable test solutions, organic goods",
    normalized_domain: "ecogreen.example.com",
    industries: ["Sustainability", "Consumer Goods"],
    star_rating: 4,
    auto_star_rating: 3,
    notes: "Committed to environmental sustainability",
    manufacturing_locations: [
      { address: "321 Green St, Portland, OR", lat: 45.5152, lng: -122.6784, is_hq: true },
      { address: "654 Forest Ave, Seattle, WA", lat: 47.6062, lng: -122.3321, is_hq: false },
    ],
    manufacturing_geocodes: [
      { address: "321 Green St, Portland, OR", lat: 45.5152, lng: -122.6784 },
      { address: "654 Forest Ave, Seattle, WA", lat: 47.6062, lng: -122.3321 },
    ],
    hq_lat: 45.5152,
    hq_lng: -122.6784,
    affiliate_links: [
      {
        url: "https://example.com/ecogreen",
        name: "EcoGreen Shop",
        description: "Organic and sustainable products",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Eco-friendly headquarters", is_public: true },
      { star_level: 2, note: "Sustainable manufacturing", is_public: true },
    ],
    review_count: 78,
    avg_rating: 4.3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-premier-luxury-goods",
    company_name: "Premier Luxury Goods",
    name: "Premier Luxury Goods",
    tagline: "Premium quality luxury items",
    website_url: "https://premierluxury.example.com",
    amazon_store_url: "https://amazon.com/s?k=premier+luxury",
    amazon_url: "https://amazon.com/s?k=premier+luxury",
    logo_url: "https://via.placeholder.com/150?text=Premier",
    product_keywords: "luxury goods, premium test products, exclusive items",
    normalized_domain: "premierluxury.example.com",
    industries: ["Luxury", "Retail"],
    star_rating: 5,
    auto_star_rating: 3,
    notes: "High-end exclusive products",
    manufacturing_locations: [
      { address: "999 Luxury Ln, Miami, FL", lat: 25.7617, lng: -80.1918, is_hq: true },
      { address: "111 Elite Way, Beverly Hills, CA", lat: 34.0822, lng: -118.4065, is_hq: false },
    ],
    manufacturing_geocodes: [
      { address: "999 Luxury Ln, Miami, FL", lat: 25.7617, lng: -80.1918 },
      { address: "111 Elite Way, Beverly Hills, CA", lat: 34.0822, lng: -118.4065 },
    ],
    hq_lat: 25.7617,
    hq_lng: -80.1918,
    affiliate_links: [
      {
        url: "https://example.com/premier",
        name: "Premier Boutique",
        description: "Exclusive luxury collection",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 5, note: "Premium brand experience", is_public: true },
    ],
    review_count: 95,
    avg_rating: 4.9,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-healthfirst-wellness",
    company_name: "HealthFirst Wellness",
    name: "HealthFirst Wellness",
    tagline: "Your path to optimal health",
    website_url: "https://healthfirst.example.com",
    amazon_store_url: "https://amazon.com/s?k=healthfirst",
    amazon_url: "https://amazon.com/s?k=healthfirst",
    logo_url: "https://via.placeholder.com/150?text=HealthFirst",
    product_keywords: "wellness supplements, test products, health vitamins",
    normalized_domain: "healthfirst.example.com",
    industries: ["Health & Wellness", "Supplements"],
    star_rating: 4,
    auto_star_rating: 2,
    notes: "Wellness and supplement provider",
    manufacturing_locations: [
      { address: "555 Health Ave, Austin, TX", lat: 30.2672, lng: -97.7431, is_hq: true },
    ],
    manufacturing_geocodes: [
      { address: "555 Health Ave, Austin, TX", lat: 30.2672, lng: -97.7431 },
    ],
    hq_lat: 30.2672,
    hq_lng: -97.7431,
    affiliate_links: [
      {
        url: "https://example.com/healthfirst",
        name: "HealthFirst Store",
        description: "Wellness products and supplements",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Modern wellness facilities", is_public: true },
    ],
    review_count: 62,
    avg_rating: 4.4,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-smarttech-solutions",
    company_name: "SmartTech Solutions",
    name: "SmartTech Solutions",
    tagline: "Smart technology for modern living",
    website_url: "https://smarttech.example.com",
    amazon_store_url: "https://amazon.com/s?k=smarttech",
    amazon_url: "https://amazon.com/s?k=smarttech",
    logo_url: "https://via.placeholder.com/150?text=SmartTech",
    product_keywords: "smart home devices, test IoT solutions, connected technology",
    normalized_domain: "smarttech.example.com",
    industries: ["IoT", "Smart Home"],
    star_rating: 4,
    auto_star_rating: 3,
    notes: "IoT and smart home solutions",
    manufacturing_locations: [
      { address: "777 Smart St, Boston, MA", lat: 42.3601, lng: -71.0589, is_hq: true },
      { address: "888 Connected Ct, Denver, CO", lat: 39.7392, lng: -104.9903, is_hq: false },
    ],
    manufacturing_geocodes: [
      { address: "777 Smart St, Boston, MA", lat: 42.3601, lng: -71.0589 },
      { address: "888 Connected Ct, Denver, CO", lat: 39.7392, lng: -104.9903 },
    ],
    hq_lat: 42.3601,
    hq_lng: -71.0589,
    affiliate_links: [
      {
        url: "https://example.com/smarttech",
        name: "SmartTech Hub",
        description: "Smart home products and solutions",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Innovation-focused HQ", is_public: true },
      { star_level: 2, note: "Multi-location manufacturing", is_public: true },
      { star_level: 3, note: "Positive customer feedback", is_public: true },
    ],
    review_count: 88,
    avg_rating: 4.6,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-gourmet-treats",
    company_name: "Gourmet Treats",
    name: "Gourmet Treats",
    tagline: "Artisanal food products",
    website_url: "https://gourmetreats.example.com",
    amazon_store_url: "https://amazon.com/s?k=gourmet+treats",
    amazon_url: "https://amazon.com/s?k=gourmet+treats",
    logo_url: "https://via.placeholder.com/150?text=Gourmet",
    product_keywords: "artisanal food, test products, gourmet treats",
    normalized_domain: "gourmetreats.example.com",
    industries: ["Food & Beverage", "Gourmet"],
    star_rating: 3,
    auto_star_rating: 2,
    notes: "Premium artisanal foods",
    manufacturing_locations: [
      { address: "333 Culinary Ct, Napa, CA", lat: 38.2919, lng: -122.2580, is_hq: true },
    ],
    manufacturing_geocodes: [
      { address: "333 Culinary Ct, Napa, CA", lat: 38.2919, lng: -122.2580 },
    ],
    hq_lat: 38.2919,
    hq_lng: -122.2580,
    affiliate_links: [
      {
        url: "https://example.com/gourmet",
        name: "Gourmet Shop",
        description: "Premium food and wine",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Premium HQ location", is_public: true },
    ],
    review_count: 41,
    avg_rating: 4.2,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-fitlife-equipment",
    company_name: "FitLife Equipment",
    name: "FitLife Equipment",
    tagline: "Professional fitness equipment",
    website_url: "https://fitlife.example.com",
    amazon_store_url: "https://amazon.com/s?k=fitlife",
    amazon_url: "https://amazon.com/s?k=fitlife",
    logo_url: "https://via.placeholder.com/150?text=FitLife",
    product_keywords: "fitness equipment, test gym machines, sports gear",
    normalized_domain: "fitlife.example.com",
    industries: ["Fitness", "Sports"],
    star_rating: 4,
    auto_star_rating: 3,
    notes: "Professional gym and fitness equipment",
    manufacturing_locations: [
      { address: "444 Gym Blvd, Houston, TX", lat: 29.7604, lng: -95.3698, is_hq: true },
      { address: "555 Fitness Way, Phoenix, AZ", lat: 33.4484, lng: -112.074, is_hq: false },
    ],
    manufacturing_geocodes: [
      { address: "444 Gym Blvd, Houston, TX", lat: 29.7604, lng: -95.3698 },
      { address: "555 Fitness Way, Phoenix, AZ", lat: 33.4484, lng: -112.074 },
    ],
    hq_lat: 29.7604,
    hq_lng: -95.3698,
    affiliate_links: [
      {
        url: "https://example.com/fitlife",
        name: "FitLife Direct",
        description: "Professional fitness equipment",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Major fitness hub", is_public: true },
      { star_level: 2, note: "National distribution", is_public: true },
      { star_level: 3, note: "Strong reviews", is_public: true },
    ],
    review_count: 73,
    avg_rating: 4.5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-eduvision-solutions",
    company_name: "EduVision Solutions",
    name: "EduVision Solutions",
    tagline: "Educational technology platform",
    website_url: "https://eduvision.example.com",
    amazon_store_url: "https://amazon.com/s?k=eduvision",
    amazon_url: "https://amazon.com/s?k=eduvision",
    logo_url: "https://via.placeholder.com/150?text=EduVision",
    product_keywords: "education platforms, test learning systems, EdTech solutions",
    normalized_domain: "eduvision.example.com",
    industries: ["Education", "EdTech"],
    star_rating: 4,
    auto_star_rating: 1,
    notes: "E-learning platform provider",
    manufacturing_locations: [
      { address: "666 Education Ln, Chicago, IL", lat: 41.8781, lng: -87.6298, is_hq: true },
    ],
    manufacturing_geocodes: [
      { address: "666 Education Ln, Chicago, IL", lat: 41.8781, lng: -87.6298 },
    ],
    hq_lat: 41.8781,
    hq_lng: -87.6298,
    affiliate_links: [
      {
        url: "https://example.com/eduvision",
        name: "EduVision Academy",
        description: "Online learning platform",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Leading education center", is_public: true },
    ],
    review_count: 55,
    avg_rating: 4.3,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "test-globaltrade-export",
    company_name: "GlobalTrade Export",
    name: "GlobalTrade Export",
    tagline: "International trade solutions",
    website_url: "https://globaltrade.example.com",
    amazon_store_url: "https://amazon.com/s?k=globaltrade",
    amazon_url: "https://amazon.com/s?k=globaltrade",
    logo_url: "https://via.placeholder.com/150?text=GlobalTrade",
    product_keywords: "import export, test logistics, international trade",
    normalized_domain: "globaltrade.example.com",
    industries: ["Import/Export", "Logistics"],
    star_rating: 3,
    auto_star_rating: 3,
    notes: "International trade facilitator",
    manufacturing_locations: [
      { address: "888 Trade St, New York, NY", lat: 40.7128, lng: -74.006, is_hq: true },
      { address: "999 Export Way, Long Beach, CA", lat: 33.7701, lng: -118.1937, is_hq: false },
    ],
    manufacturing_geocodes: [
      { address: "888 Trade St, New York, NY", lat: 40.7128, lng: -74.006 },
      { address: "999 Export Way, Long Beach, CA", lat: 33.7701, lng: -118.1937 },
    ],
    hq_lat: 40.7128,
    hq_lng: -74.006,
    affiliate_links: [
      {
        url: "https://example.com/globaltrade",
        name: "GlobalTrade Partner",
        description: "International trade services",
        is_public: true,
      },
    ],
    star_explanation: [
      { star_level: 1, note: "Major trade ports", is_public: true },
      { star_level: 2, note: "Multiple distribution centers", is_public: true },
      { star_level: 3, note: "Reliable partnerships", is_public: true },
    ],
    review_count: 51,
    avg_rating: 4.1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

async function seedCompanies() {
  try {
    console.log("🌱 Starting to seed sample companies...");
    
    let createdCount = 0;
    for (const company of sampleCompanies) {
      try {
        await container.items.upsert(company);
        console.log(`✓ Seeded: ${company.company_name}`);
        createdCount += 1;
      } catch (e) {
        console.warn(`⚠ Failed to seed ${company.company_name}:`, e?.message);
      }
    }

    console.log(`\n✅ Successfully seeded ${createdCount}/${sampleCompanies.length} companies`);
  } catch (error) {
    console.error("❌ Error seeding companies:", error?.message || error);
    process.exit(1);
  }
}

seedCompanies();
