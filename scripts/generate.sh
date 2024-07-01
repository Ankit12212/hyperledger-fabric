#!/bin/sh
#
# Copyright IBM Corp All Rights Reserved
# SCRIPT FOR GENERATING CERTIFICATES AND ARTIFACTS

export PATH=$GOPATH/src/github.com/hyperledger/fabric/build/bin:${PWD}/../bin:${PWD}:$PATH
export FABRIC_CFG_PATH=${PWD}/../config
CHANNEL_NAME=mychannel

# Remove previous crypto material and config transactions
rm -fr ${FABRIC_CFG_PATH}/config/*
rm -fr ${FABRIC_CFG_PATH}/crypto-config/*

# Generate crypto material
cryptogen generate --config=${FABRIC_CFG_PATH}/crypto-config-orderer.yaml
if [ "$?" -ne 0 ]; then
  echo "Failed to generate crypto material for orderer..."
  exit 1
fi

cryptogen generate --config=${FABRIC_CFG_PATH}/crypto-config-org1.yaml
if [ "$?" -ne 0 ]; then
  echo "Failed to generate crypto material for org1..."
  exit 1
fi

cryptogen generate --config=${FABRIC_CFG_PATH}/crypto-config-org2.yaml
if [ "$?" -ne 0 ]; then
  echo "Failed to generate crypto material for org2..."
  exit 1
fi

# Generate genesis block for orderer
configtxgen -profile TwoOrgsOrdererGenesis -outputBlock ${FABRIC_CFG_PATH}/genesis.block -channelID $CHANNEL_NAME
if [ "$?" -ne 0 ]; then
  echo "Failed to generate orderer genesis block..."
  exit 1
fi

# Generate channel configuration transaction
configtxgen -profile TwoOrgsChannel -outputCreateChannelTx ${FABRIC_CFG_PATH}/channel.tx -channelID $CHANNEL_NAME
if [ "$?" -ne 0 ]; then
  echo "Failed to generate channel configuration transaction..."
  exit 1
fi

# Generate anchor peer transaction for Org1MSP
configtxgen -profile TwoOrgsChannel -outputAnchorPeersUpdate ${FABRIC_CFG_PATH}/Org1MSPanchors.tx -channelID $CHANNEL_NAME -asOrg Org1MSP
if [ "$?" -ne 0 ]; then
  echo "Failed to generate anchor peer update for Org1MSP..."
  exit 1
fi

# Generate anchor peer transaction for Org2MSP
configtxgen -profile TwoOrgsChannel -outputAnchorPeersUpdate ${FABRIC_CFG_PATH}/Org2MSPanchors.tx -channelID $CHANNEL_NAME -asOrg Org2MSP
if [ "$?" -ne 0 ]; then
  echo "Failed to generate anchor peer update for Org2MSP..."
  exit 1
fi
