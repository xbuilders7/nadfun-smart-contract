// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2Router02.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title Minimal ERC20 used for each pump launch
/// @notice Minting is restricted to the factory for predictable supply control
contract PumpToken {
    string public name;
    string public symbol;
    uint8 public decimals = 18;
    uint256 public totalSupply;
    address public factory;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );

    /// @notice Restricts function access to the factory contract
    modifier onlyFactory() {
        require(msg.sender == factory, "Only factory");
        _;
    }

    /// @notice Initializes token metadata and mints a starter balance to the creator
    constructor(string memory _name, string memory _symbol, address _creator) {
        name = _name;
        symbol = _symbol;
        factory = msg.sender;
        _mint(_creator, 1 ether);
    }

    /// @notice Internal helper that increases total supply and credits an account
    function _mint(address to, uint256 amount) internal {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    /// @notice Allows the factory to mint farming/bonding curve rewards
    function mintFromFactory(address to, uint256 amount) external onlyFactory {
        _mint(to, amount);
    }

    /// @notice Approves a spender to transfer tokens on behalf of msg.sender
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @notice Transfers tokens to another address
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "Insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Moves tokens on behalf of another address given sufficient allowance
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool) {
        require(balanceOf[from] >= amount, "Insufficient balance");
        require(
            allowance[from][msg.sender] >= amount,
            "Insufficient allowance"
        );
        balanceOf[from] -= amount;
        allowance[from][msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title Factory that spins up Pump tokens and manages the bonding curve lifecycle
contract PumpCloneFactory is Ownable, ReentrancyGuard {
    /// @notice Tracks bonding curve state for each deployed token
    struct TokenInfo {
        address creator;
        address tokenAddress;
        uint256 vReserveEth;
        uint256 vReserveToken;
        uint256 rReserveEth;
        int256 rReserveToken;
        bool liquidityMigrated;
    }

    mapping(address => TokenInfo) public tokens;

    address public uniswapRouter;
    address public WETH;

    /// @dev Default reserve and fee params applied to every launch
    uint256 public virtualEthReserve;
    uint256 public virtualTokenReserve;
    uint256 public realTokenReserve;
    uint256 public tradeFeeBps;
    uint256 public bpsDenominator;
    uint256 public liquidityMigrationFee;
    uint256 public accumulatedFees;

    event TokenLaunched(
        address indexed token,
        string name,
        string symbol,
        address indexed creator
    );
    
    event TokensPurchased(
        address indexed token,
        address indexed buyer,
        uint256 amount,
        uint256 cost
    );

    event TokensSold(
        address indexed token,
        address indexed seller,
        uint256 amount,
        uint256 refund
    );

    event ClaimedFee(uint256 amount);

    /// @notice Sets up router references and default bonding-curve parameters
    constructor(address _router) Ownable(msg.sender) {
        uniswapRouter = _router;
        WETH = IUniswapV2Router02(_router).WETH();

        virtualEthReserve = 15 ether / 1000;
        virtualTokenReserve = 1073000000 ether;
        realTokenReserve = 793100000 ether;
        tradeFeeBps = 100; // 1% fee in basis points
        bpsDenominator = 10000;
        liquidityMigrationFee = 18 ether / 1000;
    }

    /// @notice Deploy a new Pump token and optionally perform the first buy
    /// @param _name Token name
    /// @param _symbol Token symbol
    function launchToken(
        string memory _name,
        string memory _symbol
    ) external payable {
        PumpToken token = new PumpToken(_name, _symbol, msg.sender);
        TokenInfo storage info = tokens[address(token)];
        info.creator = msg.sender;
        info.tokenAddress = address(token);
        info.rReserveEth = 0;
        info.rReserveToken = int256(realTokenReserve);
        info.vReserveEth = virtualEthReserve;
        info.vReserveToken = virtualTokenReserve;

        if (msg.value > 0) {
            uint256 fee = (msg.value * tradeFeeBps) / bpsDenominator;
            uint256 netEthIn = msg.value - fee;
            (
                uint256 newReserveEth,
                uint256 newReserveToken
            ) = _calculateReserveAfterBuy(
                    virtualEthReserve,
                    virtualTokenReserve,
                    netEthIn
                );
            uint256 tokensOut = info.vReserveToken - newReserveToken;
            info.vReserveEth = newReserveEth;
            info.vReserveToken = newReserveToken;
            info.rReserveEth = netEthIn;
            info.rReserveToken -= int256(tokensOut);

            token.mintFromFactory(msg.sender, tokensOut);
            emit TokensPurchased(
                address(token),
                msg.sender,
                tokensOut,
                msg.value
            );
            accumulatedFees += fee;
        }
        info.liquidityMigrated = false;

        emit TokenLaunched(address(token), _name, _symbol, msg.sender);
    }

    /// @notice Pure helper that applies the bonding-curve invariant after a buy
    function _calculateReserveAfterBuy(
        uint256 reserveEth,
        uint256 reserveToken,
        uint256 ethIn
    ) internal pure returns (uint256, uint256) {
        uint256 newReserveEth = ethIn + reserveEth;
        uint256 newReserveToken = (reserveEth * reserveToken) / newReserveEth;
        return (newReserveEth, newReserveToken);
    }

    /// @notice Sell tokens back into the bonding curve prior to migration
    /// @param _token Token being sold
    /// @param tokenAmount Amount of tokens to sell
    function sellToken(
        address _token,
        uint256 tokenAmount
    ) external nonReentrant {
        TokenInfo storage info = tokens[_token];
        require(info.tokenAddress != address(0), "Invalid token");
        require(tokenAmount > 0, "Amount must be greater than 0");
        require(!info.liquidityMigrated, "Trading moved to Uniswap");

        uint256 newReserveToken = info.vReserveToken + tokenAmount;
        uint256 newReserveEth = (info.vReserveEth * info.vReserveToken) /
            newReserveToken;

        uint256 grossEthOut = info.vReserveEth - newReserveEth;
        uint256 fee = (grossEthOut * tradeFeeBps) / bpsDenominator;
        uint256 netEthOut = grossEthOut - fee;

        require(
            grossEthOut > 0 && grossEthOut <= info.rReserveEth,
            "Insufficient ETH in contract"
        );

        bool success = IERC20(_token).transferFrom(
            msg.sender,
            address(this),
            tokenAmount
        );
        require(success, "Transfer failed");

        info.vReserveEth = newReserveEth;
        info.vReserveToken = newReserveToken;
        info.rReserveEth -= grossEthOut;
        info.rReserveToken += int256(tokenAmount);

        payable(msg.sender).transfer(netEthOut);
        accumulatedFees += fee;

        emit TokensSold(_token, msg.sender, tokenAmount, netEthOut);
    }

    /// @notice Owner override for the default reserve presets
    function updateReserves(
        uint256 _vEthReserve,
        uint256 _vTokenReserve,
        uint256 _rTokenReserve
    ) external onlyOwner {
        virtualEthReserve = _vEthReserve;
        virtualTokenReserve = _vTokenReserve;
        realTokenReserve = _rTokenReserve;
    }

    /// @notice Withdraw accumulated protocol fees
    /// @notice Owner withdrawal for any ETH that accrued via protocol fees
    function claimFee(address to) external onlyOwner {
        uint256 feeAmount = accumulatedFees;
        accumulatedFees = 0;
        payable(to).transfer(feeAmount);
        emit ClaimedFee(feeAmount);
    }

    /// @notice Receives ETH from direct sends or router callbacks
    receive() external payable {}
}
