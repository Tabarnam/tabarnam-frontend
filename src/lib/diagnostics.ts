/**
 * Frontend diagnostic utility for validating API wiring.
 * 
 * This module logs the resolved API configuration at frontend startup
 * to help diagnose routing issues between the SPA and Function Apps.
 * 
 * From repo config (linkedBackend.json):
 * - SWA: tabarnam-frontend-v2
 * - Linked backend routing path: /api
 * - Primary Function App target: tabarnam-xai-dedicated
 * - External API Function App: tabarnam-xai-externalapi (used separately)
 * - Region: westus2
 * - Subscription: 78b03a8f-1fcd-4944-8793-8371ed2c7f55
 * - Resource group: tabarnam-mvp-rg
 */

import { API_BASE, FUNCTIONS_BASE } from './api';

export type WiringDiagnostics = {
  timestamp: string;
  frontend_host: string;
  resolved_api_base: string;
  is_same_origin: boolean;
  environment_mode: string;
  vite_xai_functions_base: string | undefined;
  vite_api_base: string | undefined;
  expected_behavior: string;
  validation_checklist: {
    name: string;
    status: 'ℹ️' | '✅' | '⚠️' | '❌';
    message: string;
  }[];
};

export function diagnoseWiring(): WiringDiagnostics {
  const isDev = import.meta.env.MODE === 'development';
  const isProduction = import.meta.env.PROD === true;

  const host = typeof window !== 'undefined' ? window.location.hostname : 'unknown';
  const protocol = typeof window !== 'undefined' ? window.location.protocol : 'unknown';
  const origin = typeof window !== 'undefined' ? window.location.origin : 'unknown';

  const isSameOrigin = !API_BASE.startsWith('http');
  const isProdHost = host === 'tabarnam.com' || host === 'www.tabarnam.com';
  const isAzureSwa = host.endsWith('.azurestaticapps.net') || host.includes('azurestaticapps');
  const isLocalDev = host === 'localhost' || host === '127.0.0.1' || host.startsWith('localhost:');

  const viteXaiFunctionsBase = import.meta.env.VITE_XAI_FUNCTIONS_BASE;
  const viteApiBase = import.meta.env.VITE_API_BASE;

  const checklist: WiringDiagnostics['validation_checklist'] = [];

  // Check 1: API_BASE resolution
  if (API_BASE === '/api') {
    if (isAzureSwa) {
      checklist.push({
        name: 'SWA Linked Backend Routing',
        status: '✅',
        message: `Using relative /api (SWA linked backend). Requests will route to tabarnam-xai-dedicated via linkedBackend.json routing path /api.`,
      });
    } else if (isProdHost) {
      checklist.push({
        name: 'Production Same-Origin Routing',
        status: '✅',
        message: `Using /api on production domain ${origin}. Requests will use SWA routing.`,
      });
    } else if (isLocalDev) {
      checklist.push({
        name: 'Local Development Routing',
        status: '⚠️',
        message: `Using /api on localhost. This will attempt to reach http://localhost/api/* (likely fails). Set VITE_XAI_FUNCTIONS_BASE or VITE_API_BASE to the actual Function App URL.`,
      });
    } else {
      checklist.push({
        name: 'Same-Origin Default Fallback',
        status: '⚠️',
        message: `Using /api on non-SWA, non-prod host ${host}. Ensure you have an /api proxy or backend.`,
      });
    }
  } else {
    checklist.push({
      name: 'Absolute URL Configuration',
      status: 'ℹ️',
      message: `Using absolute URL: ${API_BASE}. Ensure CORS is enabled on the target Function App if it's a different origin.`,
    });
  }

  // Check 2: Environment variables
  if (viteXaiFunctionsBase) {
    checklist.push({
      name: 'VITE_XAI_FUNCTIONS_BASE Set',
      status: 'ℹ️',
      message: `Env var VITE_XAI_FUNCTIONS_BASE="${viteXaiFunctionsBase}" (takes precedence over VITE_API_BASE).`,
    });
  } else if (viteApiBase) {
    checklist.push({
      name: 'VITE_API_BASE Set',
      status: 'ℹ️',
      message: `Env var VITE_API_BASE="${viteApiBase}" (fallback if VITE_XAI_FUNCTIONS_BASE not set).`,
    });
  } else {
    checklist.push({
      name: 'No Custom Env Vars',
      status: 'ℹ️',
      message: `Neither VITE_XAI_FUNCTIONS_BASE nor VITE_API_BASE are set. Using default fallback logic.`,
    });
  }

  // Check 3: Azure SWA Detection
  if (isAzureSwa) {
    checklist.push({
      name: 'Azure SWA Detected',
      status: '✅',
      message: `Running on Azure Static Web Apps (${host}). SWA will route /api/* to linked backend tabarnam-xai-dedicated.`,
    });
  } else if (isProdHost) {
    checklist.push({
      name: 'Production Host Detected',
      status: '✅',
      message: `Running on production domain (${host}). Requests to /api/* will use SWA routing.`,
    });
  } else {
    checklist.push({
      name: 'Non-SWA Host',
      status: 'ℹ️',
      message: `Running on ${host}. Not on Azure SWA or production domain. Requests will attempt same-origin /api.`,
    });
  }

  // Check 4: Mode validation
  if (isDev) {
    checklist.push({
      name: 'Development Mode',
      status: 'ℹ️',
      message: `Running in development mode (npm run dev). Local dev server should forward /api requests to backend.`,
    });
  } else if (isProduction) {
    checklist.push({
      name: 'Production Build',
      status: '✅',
      message: `Running in production build mode.`,
    });
  }

  // Determine expected behavior
  let expectedBehavior = '';
  if (isAzureSwa || isProdHost) {
    expectedBehavior = `Requests to ${API_BASE} should route to tabarnam-xai-dedicated Function App (via SWA linked backend or domain routing).`;
  } else if (isSameOrigin) {
    expectedBehavior = `Requests to ${API_BASE} should route to same-origin backend (proxy required for local dev).`;
  } else {
    expectedBehavior = `Requests to ${API_BASE} should reach the configured Function App (ensure CORS is enabled).`;
  }

  const diagnostics: WiringDiagnostics = {
    timestamp: new Date().toISOString(),
    frontend_host: host,
    resolved_api_base: API_BASE,
    is_same_origin: isSameOrigin,
    environment_mode: isDev ? 'development' : isProduction ? 'production' : 'unknown',
    vite_xai_functions_base: viteXaiFunctionsBase,
    vite_api_base: viteApiBase,
    expected_behavior: expectedBehavior,
    validation_checklist: checklist,
  };

  return diagnostics;
}

export function logWiringDiagnostics(): void {
  const diag = diagnoseWiring();

  // Use group for better console organization
  console.group(
    '%c[API Wiring Diagnostics] %c' + diag.timestamp,
    'font-weight: bold; color: #0066cc;',
    'color: #666;'
  );

  console.info('Frontend Host:', diag.frontend_host);
  console.info('Resolved API Base:', diag.resolved_api_base);
  console.info('Same Origin?', diag.is_same_origin ? 'Yes' : 'No');
  console.info('Expected Behavior:', diag.expected_behavior);

  console.group('Environment Variables');
  console.info('VITE_XAI_FUNCTIONS_BASE:', diag.vite_xai_functions_base ?? '(not set)');
  console.info('VITE_API_BASE:', diag.vite_api_base ?? '(not set)');
  console.groupEnd();

  console.group('Validation Checklist');
  diag.validation_checklist.forEach((check) => {
    const statusEmoji = check.status;
    console.info(`${statusEmoji} ${check.name}`, check.message);
  });
  console.groupEnd();

  console.info(
    '%cℹ️ linkedBackend.json Configuration (from repo)',
    'font-weight: bold;'
  );
  console.info('SWA Resource Name: tabarnam-frontend-v2');
  console.info('SWA Routing Path: /api');
  console.info('Linked Backend Function App: tabarnam-xai-dedicated');
  console.info('External API Function App: tabarnam-xai-externalapi');
  console.info('Region: westus2');
  console.info('Subscription ID: 78b03a8f-1fcd-4944-8793-8371ed2c7f55');
  console.info('Resource Group: tabarnam-mvp-rg');

  console.groupEnd();
}

/**
 * Returns structured wiring diagnostics for programmatic use.
 * Useful for debug UIs or telemetry.
 */
export function getWiringDiagnostics(): WiringDiagnostics {
  return diagnoseWiring();
}
