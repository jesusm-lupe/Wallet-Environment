require('dotenv').config();
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2promise');
const { Connector } = require('@google-cloudcloud-sql-connector');
const { GoogleAuth } = require('google-auth-library');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

 🔍 Middleware Log every incoming request to the console
app.use((req, res, next) = {
  console.log(`[${new Date().toISOString()}] ${req.method} request to ${req.url}`);
  next();
});

 Initialize Cloud SQL Connector
const connector = new Connector();

 1. Cloud SQL Connection Helper
async function getDbConnection() {
  console.log('  - [DB] Establishing connection to Cloud SQL...');
  const clientOpts = await connector.getOptions({
    instanceConnectionName process.env.INSTANCE_CONNECTION_NAME,
    authType 'PASSWORD',
  });

  return await mysql.createConnection({
    ...clientOpts,
    user process.env.DB_USER,
    password process.env.DB_PASSWORD,
    database process.env.DB_NAME,
  });
}

 2. Register NEW Person Data in Google Cloud SQL
async function registerPersonInCloudSql(firstName, lastName) {
  let conn;
  try {
    conn = await getDbConnection();
    console.log(`  - [DB] Inserting new member ${firstName} ${lastName}...`);

     Calculate an expiration date 1 year from today
    const expirationDate = new Date();
    expirationDate.setFullYear(expirationDate.getFullYear() + 1);
    const expirationString = expirationDate.toISOString().split('T')[0];  Format YYYY-MM-DD

     Insert the new member (Assumes 'members' table has an auto-incrementing ID)
    const [result] = await conn.execute(
      'INSERT INTO members (first_name, last_name, status, expiration_date) VALUES (, , , )',
      [firstName, lastName, 'APPROVED', expirationString]
    );

    const newMemberId = result.insertId;  Grabs the newly created auto-incremented SQL ID
    console.log(`  - [DB] Successfully registered! New Member ID ${newMemberId}`);

     Return the formatted object for the Wallet Payload
    return {
      vanId newMemberId,  We map the new SQL ID to the 'vanId' variable name to keep Wallet logic happy
      firstName firstName,
      lastName lastName,
      customFields [
        { customFieldName 'Membership Status', assignedValue 'APPROVED' },
        { customFieldName 'Expiration Date', assignedValue expirationString }
      ]
    };
  } catch (err) {
    console.error('  ❌ [DB ERROR]', err.message);
    throw err;
  } finally {
    if (conn) await conn.end();
  }
}

 3. Build Google Wallet Payload
function buildObjectPayload(objectId, classId, personData) {
  const vanId = personData.vanId;
  const firstName = personData.firstName  '';
  const lastName = personData.lastName  '';
  const fullName = `${firstName} ${lastName}`.trim();

  let status = 'Unknown';
  let expiration = 'Unknown';

  if (personData.customFields) {
    personData.customFields.forEach(field = {
      if (field.customFieldName === 'Membership Status') {
        status = String(field.assignedValue  '');
      } else if (field.customFieldName === 'Expiration Date') {
        expiration = String(field.assignedValue  '');
      }
    });
  }

  return {
    id objectId,
    classId classId,
    state 'ACTIVE',
    accountId String(vanId),  Maps to your FOLIO# label
    accountName fullName,     Maps to your UNION MEMBERSHIP label
    hexBackgroundColor '#1f12d9',  Your LUPE blue
    logo {
      sourceUri { uri 'httpsdocs.google.comdrawingsde2PACX-1vSNA_PDPmZr5xceXlTP9ZE--9xKM2vtuUe0HW_ErtT_AFwdL-oIcfMSxS0WxwpGCusH7ZIvKGl2nqb8pubw=283&h=100' }
    },
    barcode {
      type 'QR_CODE',
      value String(vanId),
      alternateText `Folio# ${vanId}`
    },
    textModulesData [
      { id 'status_field', header 'Status', body status },
      { id 'expiration_field', header 'Expiration Date', body expiration }
    ]
  };
}

 4. Generate Google Wallet Save JWT Link
function generateSaveLink(issuerId, classSuffix, objectSuffix, credsFilePath) {
  if (!fs.existsSync(credsFilePath)) {
    throw new Error(`Credentials file not found at path ${credsFilePath}`);
  }

  const creds = JSON.parse(fs.readFileSync(credsFilePath, 'utf8'));

  const claims = {
    iss creds.client_email,
    aud 'google',
    typ 'savetowallet',
    origins [],
    payload {
      loyaltyObjects [ 
        {
          id `${issuerId}.${objectSuffix}`,
          classId `${issuerId}.${classSuffix}`
        }
      ]
    }
  };

  const token = jwt.sign(claims, creds.private_key, { algorithm 'RS256' });
  return `httpspay.google.comgpvsave${token}`;
}

 5. Main Sync Orchestration (Receives personData directly now)
async function syncMemberToWallet(personData) {
  const issuerId = process.env.GOOGLE_ISSUER_ID;
  const credsFilePath = process.env.GOOGLE_CREDENTIALS_PATH  'service_account.json';
  
  const classSuffix = 'Member'; 
  const objectSuffix = `SQL_${personData.vanId}`;  Differentiate these IDs with an SQL_ prefix

   Step A Authenticate with Google
  console.log('  - [WALLET] Authenticating Service Account...');
  const auth = new GoogleAuth({
    keyFile credsFilePath,
    scopes ['httpswww.googleapis.comauthwallet_object.issuer']
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const bearerToken = tokenResponse.token;

   Step B Build payload and UPSERT object to Google Wallet API
  const objectPayload = buildObjectPayload(`${issuerId}.${objectSuffix}`, `${issuerId}.${classSuffix}`, personData);
  const walletUrl = `httpswalletobjects.googleapis.comwalletobjectsv1loyaltyObject${issuerId}.${objectSuffix}`;

  console.log(`  - [WALLET] Syncing object '${issuerId}.${objectSuffix}' to Google...`);
  try {
     Check if object exists
    await axios.get(walletUrl, {
      headers { Authorization `Bearer ${bearerToken}` }
    });
     Object exists - PUT
    await axios.put(walletUrl, objectPayload, {
      headers { Authorization `Bearer ${bearerToken}`, 'Content-Type' 'applicationjson' }
    });
    console.log('  - [WALLET] Pass object updated successfully.');
  } catch (error) {
    if (error.response && error.response.status === 404) {
       Object not found - POST
      await axios.post('httpswalletobjects.googleapis.comwalletobjectsv1loyaltyObject', objectPayload, {
        headers { Authorization `Bearer ${bearerToken}`, 'Content-Type' 'applicationjson' }
      });
      console.log('  - [WALLET] New pass object created successfully.');
    } else {
      console.error('  ❌ [WALLET API ERROR]', error.response.data  error.message);
      throw error;
    }
  }

   Step C Return Link
  console.log('  - [WALLET] Generating Save URL...');
  return generateSaveLink(issuerId, classSuffix, objectSuffix, credsFilePath);
}

 --- EXPRESS ROUTE REGISTRATION ---
app.post('apiregister-wallet', async (req, res) = {
  const { firstName, lastName } = req.body;

  if (!firstName  !lastName) {
    return res.status(400).json({ error 'First and last name are required.' });
  }

  console.log(`n🚀 Starting new member registration for ${firstName} ${lastName}`);

  try {
     1. Insert into DB and get the new ID
    const newPersonData = await registerPersonInCloudSql(firstName, lastName);
    
     2. Build the wallet pass using that new DB data
    const saveUrl = await syncMemberToWallet(newPersonData);
    
    console.log('✅ Success! Returning Save URL to frontend.n');
    res.json({ success true, saveUrl });
  } catch (error) {
    console.error('💥 Failed to register and generate wallet pass', error.message, 'n');
    res.status(500).json({ error error.message  'Failed to generate wallet pass.' });
  }
});

const PORT = process.env.PORT  3000;
app.listen(PORT, () = {
  console.log(`Server running on httplocalhost${PORT}`);
});
