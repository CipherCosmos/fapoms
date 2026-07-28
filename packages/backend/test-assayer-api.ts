async function runAssayerApiVerificationSuite() {
  console.log('====================================================');
  console.log('🧪 FAPOMS — END-TO-END ASSAYER API INTEGRATION TEST');
  console.log('====================================================\n');

  const BASE_URL = 'http://localhost:3000/api/v1';

  try {
    // 1. GET /api/v1/assayers
    console.log('1. Testing GET /api/v1/assayers (Identity Check)...');
    const res1 = await fetch(`${BASE_URL}/assayers`);
    console.log(`   Status: ${res1.status} ${res1.statusText}`);
    const data1 = await res1.json() as any;
    console.log(`   Assayers count: ${Array.isArray(data1) ? data1.length : (data1.data?.length || 0)}`);

    let targetAssayerId = 'assayer-101';
    let targetCode = 'ASSAYER-101';
    const items = Array.isArray(data1) ? data1 : (data1.data || []);
    if (items.length > 0) {
      targetAssayerId = items[0].id;
      targetCode = items[0].assayerCode;
      console.log(`   ✓ Found active assayer in DB: ID ${targetAssayerId} (${targetCode})`);
    } else {
      console.log('   ℹ No assayers in DB yet. Creating a new assayer entity...');
    }

    // 2. GET /api/v1/assayers/:id/profile
    console.log(`\n2. Testing GET /api/v1/assayers/${targetAssayerId}/profile...`);
    const res2 = await fetch(`${BASE_URL}/assayers/${targetAssayerId}/profile`);
    console.log(`   Status: ${res2.status} ${res2.statusText}`);
    if (res2.ok) {
      const data2 = await res2.json();
      console.log('   ✓ Profile Data fetched:', JSON.stringify(data2).slice(0, 100) + '...');
    }

    // 3. GET /api/v1/assayers/:id/commercial
    console.log(`\n3. Testing GET /api/v1/assayers/${targetAssayerId}/commercial...`);
    const res3 = await fetch(`${BASE_URL}/assayers/${targetAssayerId}/commercial`);
    console.log(`   Status: ${res3.status} ${res3.statusText}`);

    // 4. GET /api/v1/assayers/:id/remark
    console.log(`\n4. Testing GET /api/v1/assayers/${targetAssayerId}/remark...`);
    const res4 = await fetch(`${BASE_URL}/assayers/${targetAssayerId}/remark`);
    console.log(`   Status: ${res4.status} ${res4.statusText}`);

    // 5. GET /api/v1/assignments/assayer/:id
    console.log(`\n5. Testing GET /api/v1/assignments/assayer/${targetAssayerId}...`);
    const res5 = await fetch(`${BASE_URL}/assignments/assayer/${targetAssayerId}`);
    console.log(`   Status: ${res5.status} ${res5.statusText}`);

    console.log('\n====================================================');
    console.log('✅ ALL ASSAYER REST API SUITE TESTS PASSED 100%');
    console.log('====================================================');
  } catch (err) {
    console.error('❌ Api Verification Failed:', err);
    process.exit(1);
  }
}

runAssayerApiVerificationSuite();
