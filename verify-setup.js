#!/usr/bin/env node
// Verification script for queue trigger and diagnostic endpoints

const app = require('./api/index.js');
const triggers = app?._test?.listTriggers?.() || [];
const routes = app?._test?.listRoutes?.() || [];

console.log('\n=== QUEUE TRIGGER VERIFICATION ===\n');

// Find queue trigger
const queueTrigger = triggers.find(t => t.name === 'import-resume-worker-queue-trigger');
if (queueTrigger) {
  console.log('✅ PASS: Queue trigger is registered');
  console.log(`   - Name: ${queueTrigger.name}`);
  console.log(`   - Type: ${queueTrigger.type}`);
  console.log(`   - Queue: ${queueTrigger.queueName}`);
} else {
  console.log('❌ FAIL: Queue trigger NOT found');
  console.log(`   Available triggers: ${triggers.map(t => t.name).join(', ')}`);
}

console.log('\n=== DIAGNOSTIC ENDPOINT VERIFICATION ===\n');

// Check diagnostic endpoint
const hasDiagTriggers = routes.includes('admin/diag/triggers');
if (hasDiagTriggers) {
  console.log('✅ PASS: Diagnostic triggers endpoint is registered');
  console.log(`   Route: /api/admin/diag/triggers`);
} else {
  console.log('❌ FAIL: Diagnostic endpoint NOT registered');
  console.log(`   Available routes containing 'diag': ${routes.filter(r => r.includes('diag')).join(', ')}`);
}

console.log('\n=== TRIGGER SUMMARY ===\n');

const triggersByType = {};
triggers.forEach(t => {
  if (!triggersByType[t.type]) triggersByType[t.type] = 0;
  triggersByType[t.type]++;
});

console.log(`Total triggers registered: ${triggers.length}`);
Object.entries(triggersByType).forEach(([type, count]) => {
  console.log(`  - ${type}: ${count}`);
});

console.log('\n=== HTTP ENDPOINTS VERIFICATION ===\n');

const httpRoutes = routes.filter(r => !r.includes('queue'));
console.log(`Total HTTP endpoints registered: ${httpRoutes.length}`);

// Check key endpoints
const keyEndpoints = [
  'admin/diag/triggers',
  'import-start',
  'import-status',
  'import/resume-worker',
  'version',
  'ping',
];

keyEndpoints.forEach(endpoint => {
  if (routes.includes(endpoint)) {
    console.log(`  ✅ ${endpoint}`);
  } else {
    console.log(`  ❌ ${endpoint}`);
  }
});

console.log('\n=== OVERALL STATUS ===\n');

const queueTriggerReady = queueTrigger ? 'YES' : 'NO';
const diagEndpointReady = hasDiagTriggers ? 'YES' : 'NO';
const allReady = queueTrigger && hasDiagTriggers;

console.log(`Queue Trigger Ready: ${queueTriggerReady}`);
console.log(`Diagnostic Endpoint Ready: ${diagEndpointReady}`);
console.log(`\nDeployment Status: ${allReady ? '✅ READY FOR DEPLOYMENT' : '❌ NOT READY'}`);

process.exit(allReady ? 0 : 1);
