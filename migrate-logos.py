#!/usr/bin/env python3
"""
Database migration script to clean up invalid blob: URLs in company logo_urls.
Run this script in your local environment with Azure credentials set.

Required environment variables:
  - VITE_COSMOS_ENDPOINT or COSMOS_ENDPOINT
  - VITE_COSMOS_KEY or COSMOS_KEY
"""

import os
from azure.cosmos import CosmosClient, exceptions

def main():
    # Get credentials from environment
    endpoint = os.environ.get('VITE_COSMOS_ENDPOINT') or os.environ.get('COSMOS_ENDPOINT')
    key = os.environ.get('VITE_COSMOS_KEY') or os.environ.get('COSMOS_KEY')
    database_name = os.environ.get('COSMOS_DB', 'tabarnam')
    container_name = os.environ.get('COSMOS_CONTAINER', 'companies')
    
    if not endpoint or not key:
        print("✗ Error: Missing required environment variables")
        print("  - VITE_COSMOS_ENDPOINT or COSMOS_ENDPOINT")
        print("  - VITE_COSMOS_KEY or COSMOS_KEY")
        return False
    
    print(f"Connecting to Cosmos DB...")
    print(f"Endpoint: {endpoint[:40]}...")
    print(f"Database: {database_name}")
    print(f"Container: {container_name}\n")
    
    try:
        client = CosmosClient(endpoint, key)
        database = client.get_database_client(database_name)
        container = database.get_container_client(container_name)
        
        # Query for companies with invalid blob: logo_url
        query = "SELECT c.id, c.company_id, c.company_name, c.logo_url FROM c WHERE STARTSWITH(c.logo_url, 'blob:')"
        items = list(container.query_items(query=query, enable_cross_partition_query=True))
        
        print(f"✓ Found {len(items)} companies with invalid blob: URLs\n")
        
        if len(items) == 0:
            print("✓ No migration needed - all logo URLs are valid!")
            return True
        
        # Dry run: Print what would be changed
        print("=" * 70)
        print("DRY RUN: The following companies would be updated:")
        print("=" * 70)
        for i, item in enumerate(items, 1):
            print(f"{i}. {item.get('company_name', 'Unknown')}")
            print(f"   ID: {item.get('company_id')}")
            print(f"   Current: {item.get('logo_url', 'N/A')[:60]}...")
            print(f"   Action: Set logo_url to null\n")
        
        # Confirm before proceeding
        response = input("Proceed with migration? (yes/no): ").strip().lower()
        if response != 'yes':
            print("Migration cancelled.")
            return False
        
        print("\n" + "=" * 70)
        print("EXECUTING MIGRATION...")
        print("=" * 70 + "\n")
        
        # Actual update
        updated_count = 0
        error_count = 0
        for item in items:
            try:
                item['logo_url'] = None
                container.upsert_item(item)
                updated_count += 1
                print(f"✓ Updated: {item.get('company_name', 'Unknown')} ({item.get('company_id')})")
            except exceptions.CosmosHttpResponseError as e:
                error_count += 1
                print(f"✗ Error updating {item.get('company_id')}: {str(e)}")
            except Exception as e:
                error_count += 1
                print(f"✗ Unexpected error for {item.get('company_id')}: {str(e)}")
        
        print("\n" + "=" * 70)
        print("MIGRATION COMPLETE")
        print("=" * 70)
        print(f"✓ Successfully updated: {updated_count} companies")
        if error_count > 0:
            print(f"✗ Errors: {error_count} companies")
        print(f"Total processed: {updated_count + error_count} companies\n")
        
        return error_count == 0
        
    except Exception as e:
        print(f"✗ Error: {str(e)}\n")
        return False

if __name__ == '__main__':
    success = main()
    exit(0 if success else 1)
