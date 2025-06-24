import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  PumpCloneFactory,
  PumpToken,
} from "../typechain-types/contracts/PumpfunFactory.sol";

const parseEther = ethers.parseEther;

type LaunchOverrides = { value?: bigint };

interface BuyMathResult {
  fee: bigint;
  netEthIn: bigint;
  newReserveEth: bigint;
  newReserveToken: bigint;
  tokensOut: bigint;
}

interface SellMathResult {
  fee: bigint;
  netEthOut: bigint;
  newReserveEth: bigint;
  newReserveToken: bigint;
  grossEthOut: bigint;
}

function calculateBuyMath(
  vReserveEth: bigint,
  vReserveToken: bigint,
  ethIn: bigint,
  tradeFeeBps: bigint,
  bpsDenominator: bigint
): BuyMathResult {
  const fee = (ethIn * tradeFeeBps) / bpsDenominator;
  const netEthIn = ethIn - fee;
  const newReserveEth = vReserveEth + netEthIn;
  const newReserveToken = (vReserveEth * vReserveToken) / newReserveEth;
  const tokensOut = vReserveToken - newReserveToken;
  return { fee, netEthIn, newReserveEth, newReserveToken, tokensOut };
}

function calculateSellMath(
  vReserveEth: bigint,
  vReserveToken: bigint,
  tokenAmount: bigint,
  tradeFeeBps: bigint,
  bpsDenominator: bigint
): SellMathResult {
  const newReserveToken = vReserveToken + tokenAmount;
  const newReserveEth = (vReserveEth * vReserveToken) / newReserveToken;
  const grossEthOut = vReserveEth - newReserveEth;
  const fee = (grossEthOut * tradeFeeBps) / bpsDenominator;
  const netEthOut = grossEthOut - fee;
  return { fee, netEthOut, newReserveEth, newReserveToken, grossEthOut };
}

describe("PumpCloneFactory", function () {
  async function deployFactoryFixture() {
    const [owner, user, feeRecipient] = await ethers.getSigners();
    const wethAddress = owner.address;

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(wethAddress);

    const Factory = await ethers.getContractFactory("PumpCloneFactory");
    const factory = (await Factory.deploy(
      await router.getAddress()
    )) as PumpCloneFactory;

    return { factory, router, owner, user, feeRecipient, wethAddress };
  }

  async function getTokenAddressFromReceipt(
    factory: PumpCloneFactory,
    blockNumber: number
  ) {
    const [event] = await factory.queryFilter(
      factory.filters.TokenLaunched(),
      blockNumber,
      blockNumber
    );
    return event!.args.token as string;
  }

  async function launchTokenAndGetAddress(
    factory: PumpCloneFactory,
    name: string,
    symbol: string,
    overrides: LaunchOverrides = {}
  ) {
    const tx = await factory.launchToken(name, symbol, overrides);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error("launchToken transaction was not mined");
    }
    const tokenAddress = await getTokenAddressFromReceipt(
      factory,
      receipt.blockNumber
    );
    return { tokenAddress, receipt, tx };
  }

  describe("constructor", function () {
    it("initializes router, owner, and default parameters", async function () {
      const { factory, router, owner, wethAddress } = await loadFixture(
        deployFactoryFixture
      );

      expect(await factory.owner()).to.equal(owner.address);
      expect(await factory.uniswapRouter()).to.equal(await router.getAddress());
      expect(await factory.WETH()).to.equal(wethAddress);
      expect(await factory.virtualEthReserve()).to.equal(
        parseEther("0.015")
      );
      expect(await factory.virtualTokenReserve()).to.equal(
        parseEther("1073000000")
      );
      expect(await factory.realTokenReserve()).to.equal(
        parseEther("793100000")
      );
      expect(await factory.tradeFeeBps()).to.equal(100n);
      expect(await factory.bpsDenominator()).to.equal(10000n);
      expect(await factory.liquidityMigrationFee()).to.equal(
        parseEther("0.018")
      );
    });
  });

  describe("launchToken", function () {
    it("stores token info and mints the initial creator allocation", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      const { tokenAddress } = await launchTokenAndGetAddress(
        factory,
        "Alpha",
        "ALP"
      );

      const tokenInfo = await factory.tokens(tokenAddress);
      const realTokenReserve = await factory.realTokenReserve();
      const virtualEthReserve = await factory.virtualEthReserve();
      const virtualTokenReserve = await factory.virtualTokenReserve();

      expect(tokenInfo.creator).to.equal(owner.address);
      expect(tokenInfo.tokenAddress).to.equal(tokenAddress);
      expect(tokenInfo.rReserveEth).to.equal(0n);
      expect(tokenInfo.rReserveToken).to.equal(realTokenReserve);
      expect(tokenInfo.vReserveEth).to.equal(virtualEthReserve);
      expect(tokenInfo.vReserveToken).to.equal(virtualTokenReserve);
      expect(tokenInfo.liquidityMigrated).to.equal(false);

      const token = (await ethers.getContractAt(
        "PumpToken",
        tokenAddress
      )) as PumpToken;
      const initialMint = parseEther("1");

      expect(await token.balanceOf(owner.address)).to.equal(initialMint);
      expect(await token.totalSupply()).to.equal(initialMint);
    });

    it("performs the optional initial buy and accounts for fees", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      const value = parseEther("1");
      const vReserveEth = await factory.virtualEthReserve();
      const vReserveToken = await factory.virtualTokenReserve();
      const tradeFeeBps = await factory.tradeFeeBps();
      const bpsDenominator = await factory.bpsDenominator();
      const realTokenReserve = await factory.realTokenReserve();

      const expected = calculateBuyMath(
        vReserveEth,
        vReserveToken,
        value,
        tradeFeeBps,
        bpsDenominator
      );

      const txPromise = factory.launchToken("Beta", "BTA", { value });

      await expect(txPromise)
        .to.emit(factory, "TokensPurchased")
        .withArgs(anyValue, owner.address, expected.tokensOut, value);

      const receipt = await (await txPromise).wait();
      if (!receipt) {
        throw new Error("launchToken transaction was not mined");
      }
      const tokenAddress = await getTokenAddressFromReceipt(
        factory,
        receipt.blockNumber
      );

      const tokenInfo = await factory.tokens(tokenAddress);
      const token = (await ethers.getContractAt(
        "PumpToken",
        tokenAddress
      )) as PumpToken;
      const initialMint = parseEther("1");

      expect(tokenInfo.vReserveEth).to.equal(expected.newReserveEth);
      expect(tokenInfo.vReserveToken).to.equal(expected.newReserveToken);
      expect(tokenInfo.rReserveEth).to.equal(expected.netEthIn);
      expect(tokenInfo.rReserveToken).to.equal(
        realTokenReserve - expected.tokensOut
      );
      expect(await token.balanceOf(owner.address)).to.equal(
        initialMint + expected.tokensOut
      );
      expect(await token.totalSupply()).to.equal(
        initialMint + expected.tokensOut
      );
      expect(await factory.accumulatedFees()).to.equal(expected.fee);
    });
  });

  describe("sellToken", function () {
    it("reverts for unknown tokens or invalid amounts", async function () {
      const { factory } = await loadFixture(deployFactoryFixture);
      await expect(factory.sellToken(ethers.ZeroAddress, 1n)).to.be.revertedWith(
        "Invalid token"
      );

      const value = parseEther("1");
      const { tokenAddress } = await launchTokenAndGetAddress(
        factory,
        "Delta",
        "DLT",
        { value }
      );

      await expect(factory.sellToken(tokenAddress, 0n)).to.be.revertedWith(
        "Amount must be greater than 0"
      );
    });

    it("sells tokens back into the bonding curve and accrues fees", async function () {
      const { factory, owner } = await loadFixture(deployFactoryFixture);
      const value = parseEther("1");
      const tradeFeeBps = await factory.tradeFeeBps();
      const bpsDenominator = await factory.bpsDenominator();
      const initialMint = parseEther("1");
      const originalVReserveEth = await factory.virtualEthReserve();
      const originalVReserveToken = await factory.virtualTokenReserve();

      const buyMath = calculateBuyMath(
        originalVReserveEth,
        originalVReserveToken,
        value,
        tradeFeeBps,
        bpsDenominator
      );

      const { tokenAddress } = await launchTokenAndGetAddress(
        factory,
        "Epsilon",
        "EPS",
        { value }
      );

      const tokenInfoBefore = await factory.tokens(tokenAddress);
      const token = (await ethers.getContractAt(
        "PumpToken",
        tokenAddress
      )) as PumpToken;
      const factoryAddress = await factory.getAddress();
      let sellAmount = buyMath.tokensOut / 10n;
      if (sellAmount === 0n) {
        sellAmount = 1n;
      }

      await token.approve(factoryAddress, sellAmount);

      const sellMath = calculateSellMath(
        tokenInfoBefore.vReserveEth,
        tokenInfoBefore.vReserveToken,
        sellAmount,
        tradeFeeBps,
        bpsDenominator
      );

      const sellTx = factory.sellToken(tokenAddress, sellAmount);
      await expect(sellTx)
        .to.emit(factory, "TokensSold")
        .withArgs(tokenAddress, owner.address, sellAmount, sellMath.netEthOut);
      await (await sellTx).wait();

      const tokenInfoAfter = await factory.tokens(tokenAddress);
      const ownerBalance = await token.balanceOf(owner.address);
      const factoryTokenBalance = await token.balanceOf(factoryAddress);

      expect(tokenInfoAfter.vReserveEth).to.equal(sellMath.newReserveEth);
      expect(tokenInfoAfter.vReserveToken).to.equal(sellMath.newReserveToken);
      expect(tokenInfoAfter.rReserveEth).to.equal(
        tokenInfoBefore.rReserveEth - sellMath.grossEthOut
      );
      expect(tokenInfoAfter.rReserveToken).to.equal(
        tokenInfoBefore.rReserveToken + sellAmount
      );
      expect(ownerBalance).to.equal(
        initialMint + buyMath.tokensOut - sellAmount
      );
      expect(factoryTokenBalance).to.equal(sellAmount);
      expect(await factory.accumulatedFees()).to.equal(
        buyMath.fee + sellMath.fee
      );
    });
  });

  describe("admin controls", function () {
    it("allows only the owner to update reserve parameters", async function () {
      const { factory, user } = await loadFixture(deployFactoryFixture);
      const newVirtualEth = parseEther("0.02");
      const newVirtualToken = parseEther("10");
      const newRealToken = parseEther("20");

      await expect(
        factory
          .connect(user)
          .updateReserves(newVirtualEth, newVirtualToken, newRealToken)
      )
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(user.address);

      await factory.updateReserves(
        newVirtualEth,
        newVirtualToken,
        newRealToken
      );

      expect(await factory.virtualEthReserve()).to.equal(newVirtualEth);
      expect(await factory.virtualTokenReserve()).to.equal(newVirtualToken);
      expect(await factory.realTokenReserve()).to.equal(newRealToken);
    });

    it("lets the owner withdraw accumulated fees", async function () {
      const { factory, user, feeRecipient } = await loadFixture(
        deployFactoryFixture
      );
      const value = parseEther("1");

      await launchTokenAndGetAddress(factory, "Zeta", "ZET", { value });
      const fees = await factory.accumulatedFees();
      const factoryAddress = await factory.getAddress();

      await expect(
        factory.connect(user).claimFee(feeRecipient.address)
      )
        .to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
        .withArgs(user.address);

      const factoryBalanceBefore = await ethers.provider.getBalance(
        factoryAddress
      );
      const recipientBalanceBefore = await ethers.provider.getBalance(
        feeRecipient.address
      );
      const claimTxPromise = factory.claimFee(feeRecipient.address);

      await expect(claimTxPromise)
        .to.emit(factory, "ClaimedFee")
        .withArgs(fees);

      await (await claimTxPromise).wait();

      const factoryBalanceAfter = await ethers.provider.getBalance(
        factoryAddress
      );
      const recipientBalanceAfter = await ethers.provider.getBalance(
        feeRecipient.address
      );

      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(fees);
      expect(factoryBalanceBefore - factoryBalanceAfter).to.equal(fees);

      expect(await factory.accumulatedFees()).to.equal(0n);
    });
  });
});
