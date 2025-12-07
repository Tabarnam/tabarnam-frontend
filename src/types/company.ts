// Company and Rating types for Tabarnam

export type RatingIconType = "star" | "heart";

export interface StarNote {
  id: string;
  text: string;
  is_public: boolean;
  created_at?: string;
  updated_at?: string;
  created_by?: string;
}

export interface StarUnit {
  value: number; // 0.0 - 1.0 in steps of 0.1
  notes: StarNote[];
}

export interface CompanyRating {
  star1: StarUnit;
  star2: StarUnit;
  star3: StarUnit;
  star4: StarUnit;
  star5: StarUnit;
}

export interface HeadquartersLocation {
  address?: string;
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
  is_hq?: boolean; // true for primary, false for additional
}

export interface LocationSource {
  location: string; // e.g., "San Francisco, CA, USA"
  source_url?: string; // URL to the source
  source_type?: "official_website" | "government_guide" | "b2b_directory" | "trade_data" | "packaging" | "media" | "other"; // source type
  location_type?: "headquarters" | "manufacturing"; // which type of location
}

export interface Company {
  id?: string;
  company_id?: string;
  company_name?: string;
  name?: string;
  url?: string;
  website_url?: string;
  domain?: string;
  normalized_domain?: string;
  tagline?: string;
  industries?: string[];
  keywords?: string[];
  product_keywords?: string[];
  headquarters_location?: string;
  headquarters_locations?: HeadquartersLocation[];
  hq_lat?: number;
  hq_lng?: number;
  manufacturing_locations?: string[];
  red_flag?: boolean;
  red_flag_reason?: string;
  location_confidence?: "low" | "medium" | "high";
  amazon_store_url?: string;
  amazon_url?: string;
  tagline?: string;
  logo_url?: string;
  location_sources?: LocationSource[];
  show_location_sources_to_users?: boolean;

  // Legacy fields (for backward compatibility)
  star_rating?: number;
  star_overrides?: any;
  admin_manual_extra?: number | null;
  star_notes?: any;
  star_explanation?: any;
  
  // New rating schema
  rating_icon_type?: RatingIconType;
  rating?: CompanyRating;
  
  // Metadata
  created_at?: string;
  updated_at?: string;
  source?: string;
  session_id?: string;
}

// Helper function to create empty star
export const emptyStar = (): StarUnit => ({
  value: 0.0,
  notes: [],
});

// Helper function to create default rating
export const defaultRating = (): CompanyRating => ({
  star1: emptyStar(),
  star2: emptyStar(),
  star3: emptyStar(),
  star4: emptyStar(),
  star5: emptyStar(),
});

// Helper to ensure company has rating object
export function ensureCompanyRating(company: Company): Company {
  if (!company.rating) {
    company.rating = defaultRating();
  }
  if (!company.rating_icon_type) {
    company.rating_icon_type = "star";
  }
  return company;
}
