package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

// SmartContract provides functions for managing CBDC
type SmartContract struct {
	contractapi.Contract
}

// TokenAsset represents a CBDC token
type TokenAsset struct {
	DocType         string             `json:"docType"`
	ID              string             `json:"id"`
	Owner           string             `json:"owner"`
	Amount          float64            `json:"amount"`
	IssuerID        string             `json:"issuerId"`
	Status          string             `json:"status"` // Active, Frozen, Burned
	CreatedAt       int64              `json:"createdAt"`
	ModifiedAt      int64              `json:"modifiedAt"`
	TransactionType string             `json:"transactionType"`
	Metadata        map[string]string  `json:"metadata,omitempty"`
}

// AccountBalance represents an account's balance
type AccountBalance struct {
	DocType    string  `json:"docType"`
	AccountID  string  `json:"accountId"`
	Balance    float64 `json:"balance"`
	ModifiedAt int64   `json:"modifiedAt"`
}

// TransactionHistory represents a transaction record
type TransactionHistory struct {
	DocType    string  `json:"docType"`
	TxID       string  `json:"txId"`
	FromID     string  `json:"fromId"`
	ToID       string  `json:"toId"`
	Amount     float64 `json:"amount"`
	Type       string  `json:"type"` // Issue, Transfer, Redeem, CBToCommercial, CommercialToUser
	Timestamp  int64   `json:"timestamp"`
}

// InitLedger initializes the chaincode
func (s *SmartContract) InitLedger(ctx contractapi.TransactionContextInterface) error {
	// Nothing to initialize
	return nil
}

// IssueTokens mints new CBDC tokens (Central Bank only) - Will store in central bank's own account
func (s *SmartContract) IssueTokens(ctx contractapi.TransactionContextInterface, amount float64) error {
	// Check if caller is central bank
	err := s.validateCentralBank(ctx)
	if err != nil {
		return fmt.Errorf("only central bank can issue tokens: %v", err)
	}

	if amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}

	// Central Bank's own account ID
	centralBankID := s.getCentralBankID()

	// Get current balance of central bank
	balance, err := s.getAccountBalance(ctx, centralBankID)
	if err != nil {
		balance = &AccountBalance{
			DocType:    "balance",
			AccountID:  centralBankID,
			Balance:    0,
			ModifiedAt: time.Now().Unix(),
		}
	}

	// Update central bank balance
	balance.Balance += amount
	balance.ModifiedAt = time.Now().Unix()

	// Get the caller's Common Name to set as the owner
	owner, err := s.getCallerID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get issuer identity: %v", err)
	}

	// Create token asset
	tokenID := ctx.GetStub().GetTxID()
	token := TokenAsset{
		DocType:         "token",
		ID:              tokenID,
		Owner:           owner,
		Amount:          amount,
		IssuerID:        centralBankID,
		Status:          "Active",
		CreatedAt:       time.Now().Unix(),
		ModifiedAt:      time.Now().Unix(),
		TransactionType: "Issue",
	}

	// Save token
	tokenJSON, err := json.Marshal(token)
	if err != nil {
		return fmt.Errorf("failed to marshal token: %v", err)
	}
	err = ctx.GetStub().PutState(tokenID, tokenJSON)
	if err != nil {
		return fmt.Errorf("failed to put token state: %v", err)
	}

	// Save balance
	balanceJSON, err := json.Marshal(balance)
	if err != nil {
		return fmt.Errorf("failed to marshal balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(centralBankID), balanceJSON)
	if err != nil {
		return fmt.Errorf("failed to put balance state: %v", err)
	}

	// Record transaction - issue to central bank's own account
	s.recordTransaction(ctx, "", centralBankID, amount, "Issue")

	return nil
}

// TransferToCB transfers CBDC tokens from Central Bank to Commercial Bank
func (s *SmartContract) TransferToCB(ctx contractapi.TransactionContextInterface, commercialBankID string, amount float64) error {
	// Check if caller is central bank
	err := s.validateCentralBank(ctx)
	if err != nil {
		return fmt.Errorf("only central bank can transfer to commercial banks: %v", err)
	}

	if amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}

	// Validate commercial bank ID (should be from Org2)
	err = s.validateCommercialBank(ctx, commercialBankID)
	if err != nil {
		return fmt.Errorf("invalid commercial bank ID: %v", err)
	}

	centralBankID := s.getCentralBankID()

	// Get central bank balance
	cbBalance, err := s.getAccountBalance(ctx, centralBankID)
	if err != nil {
		return fmt.Errorf("failed to get central bank balance: %v", err)
	}

	// Check sufficient funds
	if cbBalance.Balance < amount {
		return fmt.Errorf("insufficient funds in central bank account")
	}

	// Get commercial bank balance
	commBalance, err := s.getAccountBalance(ctx, commercialBankID)
	if err != nil {
		commBalance = &AccountBalance{
			DocType:    "balance",
			AccountID:  commercialBankID,
			Balance:    0,
			ModifiedAt: time.Now().Unix(),
		}
	}

	// Update balances
	cbBalance.Balance -= amount
	commBalance.Balance += amount
	currentTime := time.Now().Unix()
	cbBalance.ModifiedAt = currentTime
	commBalance.ModifiedAt = currentTime

	// Save central bank balance
	cbBalanceJSON, err := json.Marshal(cbBalance)
	if err != nil {
		return fmt.Errorf("failed to marshal central bank balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(centralBankID), cbBalanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update central bank balance: %v", err)
	}

	// Save commercial bank balance
	commBalanceJSON, err := json.Marshal(commBalance)
	if err != nil {
		return fmt.Errorf("failed to marshal commercial bank balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(commercialBankID), commBalanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update commercial bank balance: %v", err)
	}

	// Record transaction
	s.recordTransaction(ctx, centralBankID, commercialBankID, amount, "CBToCommercial")

	return nil
}

// TransferToUser transfers CBDC tokens from Commercial Bank to end user
func (s *SmartContract) TransferToUser(ctx contractapi.TransactionContextInterface, userID string, amount float64) error {
	// Get caller's identity (commercial bank)
	caller, err := s.getCallerID(ctx)
	if err != nil {
		return err
	}

	// Validate that caller is a commercial bank
	err = s.validateCallerIsCommercialBank(ctx)
	if err != nil {
		return fmt.Errorf("only commercial banks can transfer to users: %v", err)
	}

	if amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}

	// Get commercial bank balance
	bankBalance, err := s.getAccountBalance(ctx, caller)
	if err != nil {
		return fmt.Errorf("failed to get commercial bank balance: %v", err)
	}

	// Check sufficient funds
	if bankBalance.Balance < amount {
		return fmt.Errorf("insufficient funds in commercial bank account")
	}

	// Get user balance
	userBalance, err := s.getAccountBalance(ctx, userID)
	if err != nil {
		userBalance = &AccountBalance{
			DocType:    "balance",
			AccountID:  userID,
			Balance:    0,
			ModifiedAt: time.Now().Unix(),
		}
	}

	// Update balances
	bankBalance.Balance -= amount
	userBalance.Balance += amount
	currentTime := time.Now().Unix()
	bankBalance.ModifiedAt = currentTime
	userBalance.ModifiedAt = currentTime

	// Save bank balance
	bankBalanceJSON, err := json.Marshal(bankBalance)
	if err != nil {
		return fmt.Errorf("failed to marshal bank balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(caller), bankBalanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update bank balance: %v", err)
	}

	// Save user balance
	userBalanceJSON, err := json.Marshal(userBalance)
	if err != nil {
		return fmt.Errorf("failed to marshal user balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(userID), userBalanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update user balance: %v", err)
	}

	// Record transaction
	s.recordTransaction(ctx, caller, userID, amount, "CommercialToUser")

	return nil
}

// TransferTokens transfers CBDC tokens between accounts (user to user)
// func (s *SmartContract) TransferTokens(ctx contractapi.TransactionContextInterface, fromID string, toID string, amount float64) error {
// 	if amount <= 0 {
// 		return fmt.Errorf("amount must be positive")
// 	}

// 	// Validate sender
// 	caller, err := s.getCallerID(ctx)
// 	if err != nil {
// 		return err
// 	}
// 	if caller != fromID {
// 		return fmt.Errorf("caller not authorized to transfer from this account")
// 	}

// 	// Get sender's balance
// 	senderBalance, err := s.getAccountBalance(ctx, fromID)
// 	if err != nil {
// 		return fmt.Errorf("failed to get sender balance: %v", err)
// 	}

// 	// Check sufficient funds
// 	if senderBalance.Balance < amount {
// 		return fmt.Errorf("insufficient funds")
// 	}

// 	// Get receiver's balance
// 	receiverBalance, err := s.getAccountBalance(ctx, toID)
// 	if err != nil {
// 		receiverBalance = &AccountBalance{
// 			DocType:    "balance",
// 			AccountID:  toID,
// 			Balance:    0,
// 			ModifiedAt: time.Now().Unix(),
// 		}
// 	}

// 	// Update balances
// 	senderBalance.Balance -= amount
// 	receiverBalance.Balance += amount
// 	currentTime := time.Now().Unix()
// 	senderBalance.ModifiedAt = currentTime
// 	receiverBalance.ModifiedAt = currentTime

// 	// Save sender's balance
// 	senderBalanceJSON, err := json.Marshal(senderBalance)
// 	if err != nil {
// 		return fmt.Errorf("failed to marshal sender balance: %v", err)
// 	}
// 	err = ctx.GetStub().PutState(s.getBalanceKey(fromID), senderBalanceJSON)
// 	if err != nil {
// 		return fmt.Errorf("failed to update sender balance: %v", err)
// 	}

// 	// Save receiver's balance
// 	receiverBalanceJSON, err := json.Marshal(receiverBalance)
// 	if err != nil {
// 		return fmt.Errorf("failed to marshal receiver balance: %v", err)
// 	}
// 	err = ctx.GetStub().PutState(s.getBalanceKey(toID), receiverBalanceJSON)
// 	if err != nil {
// 		return fmt.Errorf("failed to update receiver balance: %v", err)
// 	}

// 	// Record transaction
// 	s.recordTransaction(ctx, fromID, toID, amount, "Transfer")

// 	return nil
// }

// TransferTokens transfers CBDC tokens between accounts (user to user)
func (s *SmartContract) TransferTokens(ctx contractapi.TransactionContextInterface, fromID string, toID string, amount float64) error {
	if amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}

	// Validate sender
	caller, err := s.getCallerID(ctx)
	if err != nil {
		return err
	}
	if caller != fromID {
		return fmt.Errorf("caller not authorized to transfer from this account")
	}

	// Get sender's balance
	senderBalance, err := s.getAccountBalance(ctx, fromID)
	if err != nil {
		return fmt.Errorf("failed to get sender balance: %v", err)
	}

	// Check sufficient funds
	if senderBalance.Balance < amount {
		return fmt.Errorf("Insufficient balance for %s. Available: %.2f, Required: %.2f", fromID, senderBalance.Balance, amount)
	}

	// Get receiver's balance
	receiverBalance, err := s.getAccountBalance(ctx, toID)
	if err != nil {
		return fmt.Errorf("failed to get receiver balance: %v", err)
	}

	// Update balances
	senderBalance.Balance -= amount
	receiverBalance.Balance += amount
	currentTime := time.Now().Unix()
	senderBalance.ModifiedAt = currentTime
	receiverBalance.ModifiedAt = currentTime

	// Save sender's balance
	senderBalanceJSON, err := json.Marshal(senderBalance)
	if err != nil {
		return fmt.Errorf("failed to marshal sender balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(fromID), senderBalanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update sender balance: %v", err)
	}

	// Save receiver's balance
	receiverBalanceJSON, err := json.Marshal(receiverBalance)
	if err != nil {
		return fmt.Errorf("failed to marshal receiver balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(toID), receiverBalanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update receiver balance: %v", err)
	}

	// Record transaction
	s.recordTransaction(ctx, fromID, toID, amount, "Transfer")

	return nil
}


// RedeemTokens burns CBDC tokens (Commercial bank to Central bank)
func (s *SmartContract) RedeemTokens(ctx contractapi.TransactionContextInterface, accountID string, amount float64) error {
	if amount <= 0 {
		return fmt.Errorf("amount must be positive")
	}

	// Validate caller
	caller, err := s.getCallerID(ctx)
	if err != nil {
		return err
	}
	if caller != accountID {
		return fmt.Errorf("caller not authorized to redeem from this account")
	}

	// Get balance
	balance, err := s.getAccountBalance(ctx, accountID)
	if err != nil {
		return fmt.Errorf("failed to get account balance: %v", err)
	}

	// Check sufficient funds
	if balance.Balance < amount {
		return fmt.Errorf("insufficient funds")
	}

	// Update balance
	balance.Balance -= amount
	balance.ModifiedAt = time.Now().Unix()

	// Save balance
	balanceJSON, err := json.Marshal(balance)
	if err != nil {
		return fmt.Errorf("failed to marshal balance: %v", err)
	}
	err = ctx.GetStub().PutState(s.getBalanceKey(accountID), balanceJSON)
	if err != nil {
		return fmt.Errorf("failed to update balance: %v", err)
	}

	// Record transaction
	s.recordTransaction(ctx, accountID, s.getCentralBankID(), amount, "Redeem")

	return nil
}

// GetBalance returns the balance of an account
func (s *SmartContract) GetBalance(ctx contractapi.TransactionContextInterface, accountID string) (*AccountBalance, error) {
	balance, err := s.getAccountBalance(ctx, accountID)
	if err != nil {
		return nil, fmt.Errorf("failed to get balance: %v", err)
	}
	return balance, nil
}

// GetTransactionHistory returns the transaction history for an account
func (s *SmartContract) GetTransactionHistory(ctx contractapi.TransactionContextInterface, accountID string) ([]*TransactionHistory, error) {
	queryString := fmt.Sprintf(`{
		"selector": {
			"docType": "transaction",
			"$or": [
				{"fromId": "%s"},
				{"toId": "%s"}
			]
		}
	}`, accountID, accountID)

	resultsIterator, err := ctx.GetStub().GetQueryResult(queryString)
	if err != nil {
		return nil, fmt.Errorf("failed to get transaction history: %v", err)
	}
	defer resultsIterator.Close()

	var transactions []*TransactionHistory
	for resultsIterator.HasNext() {
		queryResult, err := resultsIterator.Next()
		if err != nil {
			return nil, fmt.Errorf("failed to get next transaction: %v", err)
		}

		var transaction TransactionHistory
		err = json.Unmarshal(queryResult.Value, &transaction)
		if err != nil {
			return nil, fmt.Errorf("failed to unmarshal transaction: %v", err)
		}
		transactions = append(transactions, &transaction)
	}

	return transactions, nil
}

// Helper functions

func (s *SmartContract) validateCentralBank(ctx contractapi.TransactionContextInterface) error {
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get MSPID: %v", err)
	}
	// Allow only Org1 to act as the central bank
	if clientMSPID != "Org1MSP" {
		return fmt.Errorf("caller is not the central bank")
	}
	return nil
}

func (s *SmartContract) validateCommercialBank(ctx contractapi.TransactionContextInterface, bankID string) error {
	// In a real implementation, this would check if the bankID corresponds to a registered commercial bank
	// For now, we'll check if the ID starts with "bank" as a simple validation
	if !strings.HasPrefix(bankID, "bank") && !strings.HasPrefix(bankID, "bank_") {
		return fmt.Errorf("invalid commercial bank ID format")
	}
	return nil
}

func (s *SmartContract) validateCallerIsCommercialBank(ctx contractapi.TransactionContextInterface) error {
	clientMSPID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("failed to get MSPID: %v", err)
	}
	// Commercial banks are from Org2
	if clientMSPID != "Org2MSP" {
		return fmt.Errorf("caller is not a commercial bank")
	}
	return nil
}

func (s *SmartContract) getCallerID(ctx contractapi.TransactionContextInterface) (string, error) {
	// Get the client's X.509 certificate
	cert, err := ctx.GetClientIdentity().GetX509Certificate()
	if err != nil {
		return "", fmt.Errorf("failed to get client certificate: %v", err)
	}
	
	// Extract the Common Name (CN) from the certificate
	commonName := cert.Subject.CommonName
	if commonName == "" {
		return "", fmt.Errorf("certificate common name not found")
	}
	
	// Return just the username part (e.g., "user12211" from "user12211@org1.example.com")
	return strings.Split(commonName, "@")[0], nil
}

func (s *SmartContract) getCentralBankID() string {
	return "central-bank"
}

func (s *SmartContract) getBalanceKey(accountID string) string {
	return "balance_" + accountID
}

// func (s *SmartContract) getAccountBalance(ctx contractapi.TransactionContextInterface, accountID string) (*AccountBalance, error) {
// 	balanceBytes, err := ctx.GetStub().GetState(s.getBalanceKey(accountID))
// 	if err != nil {
// 		return nil, fmt.Errorf("failed to read balance: %v", err)
// 	}
// 	if balanceBytes == nil {
// 		return nil, fmt.Errorf("balance not found")
// 	}

// 	var balance AccountBalance
// 	err = json.Unmarshal(balanceBytes, &balance)
// 	if err != nil {
// 		return nil, fmt.Errorf("failed to unmarshal balance: %v", err)
// 	}

// 	return &balance, nil
// }

// getAccountBalance retrieves the balance of the specified account.
func (s *SmartContract) getAccountBalance(ctx contractapi.TransactionContextInterface, accountID string) (*AccountBalance, error) {
	accountKey := s.getBalanceKey(accountID)
	accountBytes, err := ctx.GetStub().GetState(accountKey)

	if err != nil {
		return nil, fmt.Errorf("failed to read from world state: %v", err)
	}

	// If balance is not found, return a zero-balance account
	if accountBytes == nil {
		return &AccountBalance{
			DocType:    "balance",
			AccountID:  accountID,
			Balance:    0,
			ModifiedAt: time.Now().Unix(),
		}, nil
	}

	var accountBalance AccountBalance
	err = json.Unmarshal(accountBytes, &accountBalance)
	if err != nil {
		return nil, fmt.Errorf("failed to unmarshal account balance: %v", err)
	}

	return &accountBalance, nil
}


func (s *SmartContract) recordTransaction(ctx contractapi.TransactionContextInterface, fromID string, toID string, amount float64, txType string) error {
	transaction := TransactionHistory{
		DocType:   "transaction",
		TxID:      ctx.GetStub().GetTxID(),
		FromID:    fromID,
		ToID:      toID,
		Amount:    amount,
		Type:      txType,
		Timestamp: time.Now().Unix(),
	}

	transactionJSON, err := json.Marshal(transaction)
	if err != nil {
		return fmt.Errorf("failed to marshal transaction: %v", err)
	}

	err = ctx.GetStub().PutState("tx_"+transaction.TxID, transactionJSON)
	if err != nil {
		return fmt.Errorf("failed to record transaction: %v", err)
	}

	return nil
}

func main() {
	chaincode, err := contractapi.NewChaincode(&SmartContract{})
	if err != nil {
		fmt.Printf("Error creating CBDC chaincode: %v", err)
		return
	}

	if err := chaincode.Start(); err != nil {
		fmt.Printf("Error starting CBDC chaincode: %v", err)
	}
}