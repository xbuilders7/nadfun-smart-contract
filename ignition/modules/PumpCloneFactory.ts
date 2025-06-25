// This setup uses Hardhat Ignition to manage smart contract deployments.
// Learn more about it at https://v2.hardhat.org/ignition

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const PumpfunModule = buildModule("PumpfunModule", (m) => {
  const mockWethAddress = m.getParameter(
    "mockWeth",
    "0x0000000000000000000000000000000000000000"
  );

  const mockRouter = m.contract("MockRouter", [mockWethAddress]);
  const factory = m.contract("PumpCloneFactory", [mockRouter]);

  return { mockRouter, factory };
});

export default PumpfunModule;