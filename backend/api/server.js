require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Gateway, Wallets } = require("fabric-network");
const FabricCAServices = require('fabric-ca-client');
const path = require("path");
const fs = require("fs");
const { X509Certificate } = require('@peculiar/x509');
const app = express();

app.use(cors());
app.use(express.json());

const ccpPath = path.resolve(__dirname, "..", "..", "..", "..", "fabric-samples", "test-network", "organizations", "peerOrganizations", "org1.example.com", "connection-org1.json");
const ccp = JSON.parse(fs.readFileSync(ccpPath, "utf8"));
const walletPath = path.join(process.cwd(), "wallet");

// 1. Admin Import Function
async function importPeerAdmin() {
    try {
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        if (await wallet.get('peer-admin')) return;

        const orgAdminPath = path.join(
            __dirname,
            '..', '..', '..', '..', 'fabric-samples', 'test-network',
            'organizations', 'peerOrganizations', 'org1.example.com',
            'users', 'Admin@org1.example.com', 'msp'
        );

        // Load certificate
        const certPath = path.join(orgAdminPath, 'signcerts', 'cert.pem');
        const cert = fs.readFileSync(certPath).toString();

        // Load private key
        const keyDir = path.join(orgAdminPath, 'keystore');
        const keyFiles = fs.readdirSync(keyDir).filter(file => file.endsWith('_sk'));
        if (!keyFiles.length) throw new Error('No private key found');
        const key = fs.readFileSync(path.join(keyDir, keyFiles[0])).toString();

        const identity = {
            credentials: { certificate: cert, privateKey: key },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        await wallet.put('peer-admin', identity);
        console.log('Peer admin imported successfully');
    } catch (error) {
        console.error('Failed to import peer admin:', error);
    }
}

// 2. Network Connection
async function connectToNetwork(user) {
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const gateway = new Gateway();
    
    await gateway.connect(ccp, {
        wallet,
        identity: user,
        discovery: { 
            enabled: true, 
            asLocalhost: true,
            // Added TLS settings
            tlsCACerts: Buffer.from(ccp.certificateAuthorities['ca.org1.example.com'].tlsCACerts.pem).toString()
        }
    });
    
    const network = await gateway.getNetwork("mychannel");
    return {
        gateway,
        contract: network.getContract("basic")
    };
}

// 3. Fixed CA Admin Initialization
// Update the initializeCaAdmin function
async function initializeCaAdmin() {
    try {
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        if (await wallet.get('ca-admin')) return;

        const caInfo = ccp.certificateAuthorities["ca.org1.example.com"];
        
        // Fix TLS certificate handling
        const tlsCACert = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(
            caInfo.url, 
            { 
                trustedRoots: tlsCACert,  // Remove array wrapper
                verify: false 
            },
            caInfo.caName
        );

        const enrollment = await ca.enroll({
            enrollmentID: 'admin',
            enrollmentSecret: 'adminpw'
        });
        
        const identity = {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        };
        await wallet.put('ca-admin', identity);
        console.log('CA Admin initialized');
    } catch (error) {
        console.error('CA Admin init failed:', error);
    }
}

// 4. Enhanced Registration Endpoint
app.post("/register", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "User ID required" });
        
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        if (await wallet.get(userId)) {
            return res.status(400).json({ error: "User exists" });
        }

        const ca = new FabricCAServices(
            ccp.certificateAuthorities["ca.org1.example.com"].url,
            { 
                trustedRoots: ccp.certificateAuthorities["ca.org1.example.com"].tlsCACerts.pem,
                verify: false 
            },
            ccp.certificateAuthorities["ca.org1.example.com"].caName
        );

        const adminIdentity = await wallet.get('ca-admin');
        if (!adminIdentity) {
            return res.status(500).json({ error: "CA Admin not initialized" });
        }

        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, 'ca-admin');

        const secret = await ca.register({
            affiliation: 'org1.department1',
            enrollmentID: userId,
            role: 'client',
            attrs: [
                { name: 'hf.Registrar.Roles', value: 'client' },
                { name: 'commonName', value: userId + '@org1.example.com' } // Add CN
            ]
        }, adminUser);

        const enrollment = await ca.enroll({
            enrollmentID: userId,
            enrollmentSecret: secret
        });

        await wallet.put(userId, {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: 'Org1MSP',
            type: 'X.509',
        });
        
        res.json({ message: "User registered" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Token Issuance
// app.post("/issueTokens", async (req, res) => {
//     try {
//         const { userId, accountId, amount } = req.body;
        
//         // Use peer-admin for token issuance
//         const { gateway, contract } = await connectToNetwork('peer-admin');
//         await contract.submitTransaction(
//             "IssueTokens", 
//             accountId, 
//             parseFloat(amount).toFixed(2) // Ensure proper number format
//         );
//         await gateway.disconnect();
//         res.json({ message: "Tokens issued" });
//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// });
app.post("/issueTokens", async (req, res) => {
    try {
        const { userId, amount } = req.body;

        // Get user's identity from the wallet
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        const userIdentity = await wallet.get(userId);
        if (!userIdentity) {
            return res.status(404).json({ error: "User not found" });
        }

        // Parse certificate using Node.js crypto
        const { X509Certificate } = await import('node:crypto');
        const cert = new X509Certificate(userIdentity.credentials.certificate);
        
        // Extract Common Name safely
        const subject = cert.subject.split('\n').find(line => line.startsWith('CN='));
        if (!subject) {
            throw new Error('Common Name not found in certificate');
        }
        const accountId = subject.split('=')[1].split('@')[0];

        // Submit transaction
        const { gateway, contract } = await connectToNetwork('peer-admin');
        await contract.submitTransaction(
            "IssueTokens", 
            accountId,
            parseFloat(amount).toFixed(2)
        );
        
        await gateway.disconnect();
        res.json({ message: "Tokens issued" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Get Balance Endpoint
// app.get("/getBalance", async (req, res) => {
//     try {
//         const { accountId } = req.query;
//         if (!accountId) {
//             return res.status(400).json({ error: "Account ID is required" });
//         }

//         // Use peer-admin for querying balance
//         const { gateway, contract } = await connectToNetwork("peer-admin");

//         const resultBuffer = await contract.evaluateTransaction("GetBalance", accountId);
//         const balanceData = JSON.parse(resultBuffer.toString());  

//         await gateway.disconnect();
        
//         res.json({
//             accountId: balanceData.accountId,
//             balance: balanceData.balance,  
//             lastModified: balanceData.modifiedAt
//         });
//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// });

app.get("/getBalance", async (req, res) => {
    try {
        const { userId, accountId } = req.query;
        const { gateway, contract } = await connectToNetwork(userId);
        const result = await contract.evaluateTransaction("GetBalance", accountId);
        await gateway.disconnect();
        res.json(JSON.parse(result.toString()));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post("/transferTokens", async (req, res) => {
    try {
        const { userId, fromId, toId, amount } = req.body;
        console.log("User ID for transfer:", userId);
        const { gateway, contract } = await connectToNetwork(userId);
        await contract.submitTransaction("TransferTokens", fromId, toId, amount);
        await gateway.disconnect();
        res.json({ message: "Tokens transferred successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Other endpoints remain similar but should use 'peer-admin' for privileged operations

// Initialize everything before starting
async function startup() {
    await importPeerAdmin();
    await initializeCaAdmin();
    const port = process.env.PORT || 5000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
}

startup();