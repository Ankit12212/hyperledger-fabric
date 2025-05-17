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

// Configuration for Org1 (Central Bank)
const org1CcpPath = path.resolve(__dirname, "..", "..", "..", "..", "fabric-samples", "test-network", "organizations", "peerOrganizations", "org1.example.com", "connection-org1.json");
const org1Ccp = JSON.parse(fs.readFileSync(org1CcpPath, "utf8"));
const org1WalletPath = path.join(process.cwd(), "wallet-org1");

// Configuration for Org2 (Commercial Banks)
const org2CcpPath = path.resolve(__dirname, "..", "..", "..", "..", "fabric-samples", "test-network", "organizations", "peerOrganizations", "org2.example.com", "connection-org2.json");
const org2Ccp = JSON.parse(fs.readFileSync(org2CcpPath, "utf8"));
const org2WalletPath = path.join(process.cwd(), "wallet-org2");

// 1. Admin Import Functions
async function importPeerAdmin(org) {
    try {
        const ccp = org === 'org1' ? org1Ccp : org2Ccp;
        const walletPath = org === 'org1' ? org1WalletPath : org2WalletPath;
        const orgMSP = org === 'org1' ? 'Org1MSP' : 'Org2MSP';
        
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        if (await wallet.get(`${org}-admin`)) return;

        const orgAdminPath = path.join(
            __dirname,
            '..', '..', '..', '..', 'fabric-samples', 'test-network',
            'organizations', 'peerOrganizations', `${org}.example.com`,
            'users', `Admin@${org}.example.com`, 'msp'
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
            mspId: orgMSP,
            type: 'X.509',
        };
        await wallet.put(`${org}-admin`, identity);
        console.log(`${org} peer admin imported successfully`);
    } catch (error) {
        console.error(`Failed to import ${org} peer admin:`, error);
    }
}

// 2. Network Connection for both organizations
async function connectToNetwork(org, user) {
    const ccp = org === 'org1' ? org1Ccp : org2Ccp;
    const walletPath = org === 'org1' ? org1WalletPath : org2WalletPath;
    
    const wallet = await Wallets.newFileSystemWallet(walletPath);
    const gateway = new Gateway();
    
    await gateway.connect(ccp, {
        wallet,
        identity: user,
        discovery: { 
            enabled: true, 
            asLocalhost: true,
            tlsCACerts: Buffer.from(ccp.certificateAuthorities[`ca.${org}.example.com`].tlsCACerts.pem).toString()
        }
    });
    
    const network = await gateway.getNetwork("mychannel");
    return {
        gateway,
        contract: network.getContract("basic")
    };
}

// 3. CA Admin Initialization for both organizations
async function initializeCaAdmin(org) {
    try {
        const ccp = org === 'org1' ? org1Ccp : org2Ccp;
        const walletPath = org === 'org1' ? org1WalletPath : org2WalletPath;
        const orgMSP = org === 'org1' ? 'Org1MSP' : 'Org2MSP';
        
        const wallet = await Wallets.newFileSystemWallet(walletPath);
        if (await wallet.get(`${org}-ca-admin`)) return;

        const caInfo = ccp.certificateAuthorities[`ca.${org}.example.com`];
        
        const tlsCACert = caInfo.tlsCACerts.pem;
        const ca = new FabricCAServices(
            caInfo.url, 
            { 
                trustedRoots: tlsCACert,
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
            mspId: orgMSP,
            type: 'X.509',
        };
        await wallet.put(`${org}-ca-admin`, identity);
        console.log(`${org.toUpperCase()} CA Admin initialized`);
    } catch (error) {
        console.error(`${org.toUpperCase()} CA Admin init failed:`, error);
    }
}

// 4. User Registration Endpoint
app.post("/register/user", async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: "User ID required" });
        
        const wallet = await Wallets.newFileSystemWallet(org1WalletPath);
        if (await wallet.get(userId)) {
            return res.status(400).json({ error: "User exists" });
        }

        const ca = new FabricCAServices(
            org1Ccp.certificateAuthorities["ca.org1.example.com"].url,
            { 
                trustedRoots: org1Ccp.certificateAuthorities["ca.org1.example.com"].tlsCACerts.pem,
                verify: false 
            },
            org1Ccp.certificateAuthorities["ca.org1.example.com"].caName
        );

        const adminIdentity = await wallet.get('org1-ca-admin');
        if (!adminIdentity) {
            return res.status(500).json({ error: "CA Admin not initialized" });
        }

        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, 'org1-ca-admin');

        const secret = await ca.register({
            affiliation: 'org1.department1',
            enrollmentID: userId,
            role: 'client',
            attrs: [
                { name: 'hf.Registrar.Roles', value: 'client' },
                { name: 'commonName', value: userId + '@org1.example.com' }
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
        
        res.json({ message: "User registered successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. Commercial Bank Registration (for Org2)
app.post("/register/bank", async (req, res) => {
    try {
        const { bankId } = req.body;
        if (!bankId) return res.status(400).json({ error: "Bank ID required" });
        
        // Ensure bank ID has proper prefix
        const formattedBankId = bankId.startsWith("bank") ? bankId : `bank${bankId}`;
        
        const wallet = await Wallets.newFileSystemWallet(org2WalletPath);
        if (await wallet.get(formattedBankId)) {
            return res.status(400).json({ error: "Bank already exists" });
        }

        const ca = new FabricCAServices(
            org2Ccp.certificateAuthorities["ca.org2.example.com"].url,
            { 
                trustedRoots: org2Ccp.certificateAuthorities["ca.org2.example.com"].tlsCACerts.pem,
                verify: false 
            },
            org2Ccp.certificateAuthorities["ca.org2.example.com"].caName
        );

        const adminIdentity = await wallet.get('org2-ca-admin');
        if (!adminIdentity) {
            return res.status(500).json({ error: "Org2 CA Admin not initialized" });
        }

        const provider = wallet.getProviderRegistry().getProvider(adminIdentity.type);
        const adminUser = await provider.getUserContext(adminIdentity, 'org2-ca-admin');

        const secret = await ca.register({
            affiliation: 'org2.department1',
            enrollmentID: formattedBankId,
            role: 'client',
            attrs: [
                { name: 'hf.Registrar.Roles', value: 'client' },
                { name: 'commonName', value: formattedBankId + '@org2.example.com' }
            ]
        }, adminUser);

        const enrollment = await ca.enroll({
            enrollmentID: formattedBankId,
            enrollmentSecret: secret
        });

        await wallet.put(formattedBankId, {
            credentials: {
                certificate: enrollment.certificate,
                privateKey: enrollment.key.toBytes(),
            },
            mspId: 'Org2MSP',
            type: 'X.509',
        });
        
        res.json({ 
            message: "Commercial bank registered successfully",
            bankId: formattedBankId
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 6. Token Issuance to Central Bank's own account
app.post("/issueTokens", async (req, res) => {
    try {
        const { amount } = req.body;
        if (!amount) return res.status(400).json({ error: "Amount required" });
        
        // Use org1-admin for token issuance
        const { gateway, contract } = await connectToNetwork('org1', 'org1-admin');
        
        await contract.submitTransaction(
            "IssueTokens", 
            parseFloat(amount).toFixed(2)
        );
        
        await gateway.disconnect();
        res.json({ message: "Tokens issued to Central Bank successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 7. Transfer from Central Bank to Commercial Bank
app.post("/transferToCB", async (req, res) => {
    try {
        const { commercialBankId, amount } = req.body;
        if (!commercialBankId || !amount) {
            return res.status(400).json({ error: "Commercial Bank ID and amount required" });
        }
        
        // Format bank ID if needed
        const formattedBankId = commercialBankId.startsWith("bank") ? 
            commercialBankId : `bank_${commercialBankId}`;
        
        // Use org1-admin for central bank transfers
        const { gateway, contract } = await connectToNetwork('org1', 'org1-admin');
        
        await contract.submitTransaction(
            "TransferToCB", 
            formattedBankId,
            parseFloat(amount).toFixed(2)
        );
        
        await gateway.disconnect();
        res.json({ message: "Tokens transferred from Central Bank to Commercial Bank successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. Transfer from Commercial Bank to End User
app.post("/transferToUser", async (req, res) => {
    try {
        const { bankId, userId, amount } = req.body;
        if (!bankId || !userId || !amount) {
            return res.status(400).json({ error: "Bank ID, User ID, and amount required" });
        }
        
        // Format bank ID if needed
        const formattedBankId = bankId.startsWith("bank") ? bankId : `bank_${bankId}`;
        
        // Use the commercial bank's identity for this transaction
        const { gateway, contract } = await connectToNetwork('org2', formattedBankId);
        
        await contract.submitTransaction(
            "TransferToUser", 
            userId,
            parseFloat(amount).toFixed(2)
        );
        
        await gateway.disconnect();
        res.json({ message: "Tokens transferred from Commercial Bank to User successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 9. User to User Transfer
// app.post("/transferTokens", async (req, res) => {
//     try {
//         const { org, userId, fromId, toId, amount } = req.body;
//         if (!userId || !fromId || !toId || !amount) {
//             return res.status(400).json({ error: "User ID, From ID, To ID, and amount required" });
//         }
        
//         // Use the user's identity for this transaction
//         const { gateway, contract } = await connectToNetwork('org1', userId);
        
//         await contract.submitTransaction(
//             "TransferTokens", 
//             fromId,
//             toId,
//             parseFloat(amount).toFixed(2)
//         );
        
//         await gateway.disconnect();
//         res.json({ message: "Tokens transferred between users successfully" });
//     } catch (error) {
//         res.status(500).json({ error: error.message });
//     }
// });
// 9. User to User Transfer (with validation)
app.post("/transferTokens", async (req, res) => {
    try {
        const { userId, fromId, toId, amount } = req.body;
        if (!userId || !fromId || !toId || !amount) {
            return res.status(400).json({ error: "User ID, From ID, To ID, and amount required" });
        }

        if (userId !== fromId) {
            return res.status(403).json({ error: "Caller cannot transfer from another account" });
        }

        const { gateway, contract } = await connectToNetwork('org1', userId);

        await contract.submitTransaction(
            "TransferTokens", 
            fromId,
            toId,
            parseFloat(amount).toFixed(2)
        );

        await gateway.disconnect();
        res.json({ message: "Tokens transferred between users successfully" });

    } catch (error) {
        // Handle Insufficient Balance error
        if (error.message.includes("Insufficient balance for")) {
            return res.status(400).json({ error: error.message });
        }
        res.status(500).json({ error: "Transaction failed. Please try again." });
    }
});

// 10. Get Balance (for any entity)
app.get("/getBalance", async (req, res) => {
    try {
        const { org, entityId, accountId } = req.query;
        if (!org || !entityId || !accountId) {
            return res.status(400).json({ error: "Organization, Entity ID, and Account ID required" });
        }
        
        // Validate org parameter
        if (org !== 'org1' && org !== 'org2') {
            return res.status(400).json({ error: "Invalid organization (use 'org1' or 'org2')" });
        }
        
        // Use the entity's identity for querying balance
        const { gateway, contract } = await connectToNetwork(org, entityId);
        
        const result = await contract.evaluateTransaction("GetBalance", accountId);
        
        await gateway.disconnect();
        res.json(JSON.parse(result.toString()));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 11. Get Transaction History
app.get("/getTransactionHistory", async (req, res) => {
    try {
        const { org, entityId, accountId } = req.query;
        if (!org || !entityId || !accountId) {
            return res.status(400).json({ error: "Organization, Entity ID, and Account ID required" });
        }
        
        // Validate org parameter
        if (org !== 'org1' && org !== 'org2') {
            return res.status(400).json({ error: "Invalid organization (use 'org1' or 'org2')" });
        }
        
        // Use the entity's identity for querying transaction history
        const { gateway, contract } = await connectToNetwork(org, entityId);
        
        const result = await contract.evaluateTransaction("GetTransactionHistory", accountId);
        
        await gateway.disconnect();
        res.json(JSON.parse(result.toString()));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Initialize everything before starting
async function startup() {
    // Create wallet directories if they don't exist
    if (!fs.existsSync(org1WalletPath)) {
        fs.mkdirSync(org1WalletPath, { recursive: true });
    }
    if (!fs.existsSync(org2WalletPath)) {
        fs.mkdirSync(org2WalletPath, { recursive: true });
    }
    
    // Import admin identities for both orgs
    await importPeerAdmin('org1');
    await importPeerAdmin('org2');
    
    // Initialize CA admins for both orgs
    await initializeCaAdmin('org1');
    await initializeCaAdmin('org2');
    
    const port = process.env.PORT || 5000;
    app.listen(port, () => console.log(`CBDC Server running on port ${port}`));
}

startup();