SELECT id,
       company_name,
       logo_url,
       tagline,
       website_url,
       amazon_store_url,
       notes,
       contact_email,
       contact_page_url,
       contact_phone,
       star_rating,
       star_explanation,
       reviews
FROM public.companies
LIMIT 1000000;