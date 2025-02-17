# Exit on first error
set -e

# Don't rewrite paths for Windows Git Bash users
export MSYS_NO_PATHCONV=1

starttime=$(date +%s)
CHANNEL_NAME=mychannel

# Clean the keystore
rm -rf ./hfc-key-store

# Shut down any existing Docker containers
docker-compose -f ../docker-compose.yaml down

# Start the Docker containers for the network
docker-compose -f ../docker-compose.yaml up -d

export CORE_PEER_MSPCONFIGPATH=/home/ankit_linux/hyperledger-project/crypto-config/peerOrganizations/org1.example.com/peers/peer0.org1.example.com/msp


# Wait for Hyperledger Fabric to start
export FABRIC_START_TIMEOUT=10
sleep ${FABRIC_START_TIMEOUT}

# Create the channel (using peer0.org1 instead of orderer)
docker exec -e "CORE_PEER_LOCALMSPID=Org1MSP" \
           -e "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/msp/peer/" \
           peer0.org1.example.com \
           peer channel create -o orderer.example.com:7050 \
           -c $CHANNEL_NAME -f /etc/hyperledger/configtx/mychannel.tx

# Join peer0.org1.example.com to the channel
docker exec -e "CORE_PEER_LOCALMSPID=Org1MSP" \
           -e "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/msp/peer/" \
           peer0.org1.example.com \
           peer channel join -b $CHANNEL_NAME.block

# Join peer0.org2.example.com to the channel
docker exec -e "CORE_PEER_LOCALMSPID=Org2MSP" \
           -e "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/msp/peer/" \
           peer0.org2.example.com \
           peer channel join -b $CHANNEL_NAME.block

# Update anchor peers for Org1MSP
docker exec -e "CORE_PEER_LOCALMSPID=Org1MSP" \
           -e "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/msp/peer/" \
           peer0.org1.example.com \
           peer channel update -o orderer.example.com:7050 \
           -c $CHANNEL_NAME -f /etc/hyperledger/configtx/Org1MSPanchors.tx

# Update anchor peers for Org2MSP
docker exec -e "CORE_PEER_LOCALMSPID=Org2MSP" \
           -e "CORE_PEER_MSPCONFIGPATH=/etc/hyperledger/msp/peer/" \
           peer0.org2.example.com \
           peer channel update -o orderer.example.com:7050 \
           -c $CHANNEL_NAME -f /etc/hyperledger/configtx/Org2MSPanchors.tx