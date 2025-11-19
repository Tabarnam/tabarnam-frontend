import { CosmosClient } from "@azure/cosmos";
import https from "https";
import * as dotenv from "dotenv";

dotenv.config();

const endpoint = process.env.COSMOS_DB_ENDPOINT;
const key = process.env.COSMOS_DB_KEY;
const googleApiKey = process.env.GOOGLE_MAPS_KEY;
const databaseId = process.env.COSMOS_DB_DATABASE || "tabarnam-db";
const containerId = process.env.COSMOS_DB_COMPANIES_CONTAINER || "companies";

if (!endpoint || !key) {
  console.error("❌ Missing COSMOS_DB_ENDPOINT or COSMOS_DB_KEY");
  process.exit(1);
}

if (!googleApiKey) {
  console.error("❌ Missing GOOGLE_MAPS_KEY");
  process.exit(1);
}

// Raw location data as provided - alternating city/country and postal codes
const rawLocations = [
  "Kabul, Afghanistan",
  "SW1A 1AA",
  "Tirana, Albania",
  "10001",
  "Algiers, Algeria",
  "90210",
  "Andorra la Vella, Andorra",
  "60601",
  "Luanda, Angola",
  "20001",
  "Saint John's, Antigua and Barbuda",
  "30301",
  "Buenos Aires, Argentina",
  "M5H 2N2",
  "Yerevan, Armenia",
  "H3C 3J7",
  "Canberra, Australia",
  "V6B 6G1",
  "Vienna, Austria",
  "T2P 1J9",
  "Baku, Azerbaijan",
  "R3C 4T7",
  "Nassau, Bahamas",
  "10115",
  "Manama, Bahrain",
  "20095",
  "Dhaka, Bangladesh",
  "80331",
  "Bridgetown, Barbados",
  "50667",
  "Minsk, Belarus",
  "60311",
  "Brussels, Belgium",
  "110001",
  "Belmopan, Belize",
  "700001",
  "Porto Novo, Benin",
  "400001",
  "Thimphu, Bhutan",
  "600001",
  "La Paz (administrative), Sucre (official), Bolivia",
  "560001",
  "Sarajevo, Bosnia and Herzegovina",
  "101",
  "Gaborone, Botswana",
  "1216",
  "Brasilia, Brazil",
  "96799",
  "Bandar Seri Begawan, Brunei",
  "2640",
  "Sofia, Bulgaria",
  "3900",
  "Ouagadougou, Burkina Faso",
  "1ZZ",
  "Gitega, Burundi",
  "1110",
  "Phnom Penh, Cambodia",
  "1160",
  "Yaounde, Cameroon",
  "47890",
  "Ottawa, Canada",
  "47899",
  "Praia, Cape Verde",
  "96939",
  "Bangui, Central African Republic",
  "96940",
  "N'Djamena, Chad",
  "00120",
  "Santiago, Chile",
  "96898",
  "Beijing, China",
  "2401",
  "Bogota, Colombia",
  "V5K 3A9",
  "Moroni, Comoros",
  "M4B 1B3",
  "Kinshasa, Congo, Democratic Republic of the",
  "700031",
  "Brazzaville, Congo, Republic of the",
  "D02 A272",
  "San Jose, Costa Rica",
  "EH1 1BB",
  "Yamoussoukro, Côte d'Ivoire (Ivory Coast)",
  "L1 8JQ",
  "Zagreb, Croatia",
  "B1 1TB",
  "Havana, Cuba",
  "CF10 1EP",
  "Nicosia, Cyprus",
  "L9 1NL",
  "Prague, Czech Republic (Czechia)",
  "Copenhagen, Denmark",
  "Djibouti, Djibouti",
  "Roseau, Dominica",
  "Santo Domingo, Dominican Republic",
  "Dili, East Timor",
  "Quito, Ecuador",
  "Cairo, Egypt",
  "San Salvador, El Salvador",
  "London, England",
  "Malabo, Equatorial Guinea",
  "Asmara, Eritrea",
  "Tallinn, Estonia",
  "Mbabane, Eswatini (Swaziland)",
  "Addis Ababa, Ethiopia",
  "Palikir, Federated States of Micronesia",
  "Suva, Fiji",
  "Helsinki, Finland",
  "Paris, France",
  "Libreville, Gabon",
  "Banjul, Gambia",
  "Tbilisi, Georgia",
  "Berlin, Germany",
  "Accra, Ghana",
  "Athens, Greece",
  "Saint George's, Grenada",
  "Guatemala City, Guatemala",
  "Conakry, Guinea",
  "Bissau, Guinea-Bissau",
  "Georgetown, Guyana",
  "Port au Prince, Haiti",
  "Tegucigalpa, Honduras",
  "Budapest, Hungary",
  "Reykjavik, Iceland",
  "New Delhi, India",
  "Jakarta, Indonesia",
  "Tehran, Iran",
  "Baghdad, Iraq",
  "Dublin, Ireland",
  "Jerusalem (very limited international recognition), Israel",
  "Rome, Italy",
  "Kingston, Jamaica",
  "Tokyo, Japan",
  "Amman, Jordan",
  "Astana, Kazakhstan",
  "Nairobi, Kenya",
  "Tarawa Atoll, Kiribati",
  "Pristina, Kosovo",
  "Kuwait City, Kuwait",
  "Bishkek, Kyrgyzstan",
  "Vientiane, Laos",
  "Riga, Latvia",
  "Beirut, Lebanon",
  "Maseru, Lesotho",
  "Monrovia, Liberia",
  "Tripoli, Libya",
  "Vaduz, Liechtenstein",
  "Vilnius, Lithuania",
  "Luxembourg, Luxembourg",
  "Antananarivo, Madagascar",
  "Lilongwe, Malawi",
  "Kuala Lumpur, Malaysia",
  "Male, Maldives",
  "Bamako, Mali",
  "Valletta, Malta",
  "Majuro, Marshall Islands",
  "Nouakchott, Mauritania",
  "Port Louis, Mauritius",
  "Mexico City, Mexico",
  "Chisinau, Moldova",
  "Monaco, Monaco",
  "Ulaanbaatar, Mongolia",
  "Podgorica, Montenegro",
  "Rabat, Morocco",
  "Maputo, Mozambique",
  "Nay Pyi Taw, Myanmar (Burma)",
  "Windhoek, Namibia",
  "No official capital, Nauru",
  "Kathmandu, Nepal",
  "Amsterdam, Netherlands",
  "Wellington, New Zealand",
  "Managua, Nicaragua",
  "Niamey, Niger",
  "Abuja, Nigeria",
  "Pyongyang, North Korea",
  "Skopje, North Macedonia (Macedonia)",
  "Belfast, Northern Ireland",
  "Oslo, Norway",
  "Muscat, Oman",
  "Islamabad, Pakistan",
  "Ngerulmud, Palau",
  "Jerusalem (very limited international recognition), Palestine",
  "Panama City, Panama",
  "Port Moresby, Papua New Guinea",
  "Asuncion, Paraguay",
  "Lima, Peru",
  "Manila, Philippines",
  "Warsaw, Poland",
  "Lisbon, Portugal",
  "Doha, Qatar",
  "Bucharest, Romania",
  "Moscow, Russia",
  "Kigali, Rwanda",
  "Basseterre, Saint Kitts and Nevis",
  "Castries, Saint Lucia",
  "Kingstown, Saint Vincent and the Grenadines",
  "Apia, Samoa",
  "San Marino, San Marino",
  "Sao Tome, Sao Tome and Principe",
  "Riyadh, Saudi Arabia",
  "Edinburgh, Scotland",
  "Dakar, Senegal",
  "Belgrade, Serbia",
  "Victoria, Seychelles",
  "Freetown, Sierra Leone",
  "Singapore, Singapore",
  "Bratislava, Slovakia",
  "Ljubljana, Slovenia",
  "Honiara, Solomon Islands",
  "Mogadishu, Somalia",
  "Pretoria, Bloemfontein, Cape Town, South Africa",
  "Seoul, South Korea",
  "Juba, South Sudan",
  "Madrid, Spain",
  "Sri Jayawardenapura Kotte, Sri Lanka",
  "Khartoum, Sudan",
  "Paramaribo, Suriname",
  "Stockholm, Sweden",
  "Bern, Switzerland",
  "Damascus, Syria",
  "Taipei, Taiwan",
  "Dushanbe, Tajikistan",
  "Dodoma, Tanzania",
  "Bangkok, Thailand",
  "Lome, Togo",
  "Nuku'alofa, Tonga",
  "Port of Spain, Trinidad and Tobago",
  "Tunis, Tunisia",
  "Ankara, Türkiye (Turkey)",
  "Ashgabat, Turkmenistan",
  "Funafuti, Tuvalu",
  "Kampala, Uganda",
  "Kyiv or Kiev, Ukraine",
  "Abu Dhabi, United Arab Emirates",
  "London, United Kingdom",
  "Washington D.C., United States",
  "Montevideo, Uruguay",
  "Tashkent, Uzbekistan",
  "Port Vila, Vanuatu",
  "Vatican City, Vatican City",
  "Caracas, Venezuela",
  "Hanoi, Vietnam",
  "Cardiff, Wales",
  "Sana'a, Yemen",
  "Lusaka, Zambia",
  "Harare, Zimbabwe",
];

// Parse locations - alternating city/country and postal codes
const locations = [];
for (let i = 0; i < rawLocations.length; i += 2) {
  if (i + 1 < rawLocations.length) {
    locations.push({
      city: rawLocations[i],
      postalCode: rawLocations[i + 1],
    });
  }
}

console.log(`📍 Parsed ${locations.length} unique locations\n`);

// Geocode a location using Google Maps API
async function geocodeLocation(city, postalCode) {
  return new Promise((resolve) => {
    const query = encodeURIComponent(`${city} ${postalCode}`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${googleApiKey}`;

    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const result = JSON.parse(data);
            if (result.results && result.results.length > 0) {
              const loc = result.results[0];
              resolve({
                formatted_address: loc.formatted_address,
                city: city,
                postal_code: postalCode,
                lat: loc.geometry.location.lat,
                lng: loc.geometry.location.lng,
              });
            } else {
              console.warn(`⚠ No geocoding result for: ${city}, ${postalCode}`);
              resolve(null);
            }
          } catch (e) {
            console.error(`❌ Geocoding error for ${city}:`, e.message);
            resolve(null);
          }
        });
      })
      .on("error", (e) => {
        console.error(`❌ HTTP error for ${city}:`, e.message);
        resolve(null);
      });
  });
}

// Update TEST companies with locations
async function seedTestLocations() {
  try {
    const client = new CosmosClient({ endpoint, key });
    const container = client.database(databaseId).container(containerId);

    // Find all TEST companies
    const sql = `SELECT c.id FROM c WHERE CONTAINS(LOWER(c.company_name), 'test company') ORDER BY c.company_name`;
    const { resources } = await container.items
      .query(sql, { enableCrossPartitionQuery: true })
      .fetchAll();

    if (resources.length === 0) {
      console.log("❌ No TEST companies found!");
      process.exit(1);
    }

    console.log(`📌 Found ${resources.length} TEST companies to update\n`);

    // Geocode locations (with delay to avoid rate limiting)
    const geocodedLocations = [];
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      process.stdout.write(`\r🗺️  Geocoding ${i + 1}/${locations.length}...`);

      const geocoded = await geocodeLocation(loc.city, loc.postalCode);
      if (geocoded) {
        geocodedLocations.push(geocoded);
      }

      // Rate limiting - wait 100ms between requests
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`\n\n✅ Geocoded ${geocodedLocations.length} locations\n`);

    // Assign locations to TEST companies
    let companyIndex = 0;
    let locationIndex = 0;

    for (const company of resources) {
      const hqLocations = [];
      const manuLocations = [];

      // Add 2 HQ locations
      for (let i = 0; i < 2 && locationIndex < geocodedLocations.length; i++) {
        const geo = geocodedLocations[locationIndex];
        hqLocations.push({
          address: geo.formatted_address,
          city: geo.city,
          postal_code: geo.postal_code,
          lat: geo.lat,
          lng: geo.lng,
          is_hq: true,
        });
        locationIndex++;
      }

      // Add 3 manufacturing locations
      for (let i = 0; i < 3 && locationIndex < geocodedLocations.length; i++) {
        const geo = geocodedLocations[locationIndex];
        manuLocations.push({
          address: geo.formatted_address,
          city: geo.city,
          postal_code: geo.postal_code,
          lat: geo.lat,
          lng: geo.lng,
          is_hq: false,
        });
        locationIndex++;
      }

      // Update company in Cosmos DB
      const updatedCompany = {
        ...company,
        headquarters_location: hqLocations[0]?.address || "",
        headquarters: hqLocations,
        manufacturing_locations: manuLocations,
        manufacturing_geocodes: manuLocations,
      };

      await container.item(company.id, company.id).replace(updatedCompany);

      companyIndex++;
      process.stdout.write(`\r✓ Updated ${companyIndex}/${resources.length} companies...`);
    }

    console.log(`\n\n✅ Successfully seeded locations for ${companyIndex} TEST companies!`);
  } catch (error) {
    console.error("❌ Error seeding locations:", error?.message || error);
    process.exit(1);
  }
}

seedTestLocations();
