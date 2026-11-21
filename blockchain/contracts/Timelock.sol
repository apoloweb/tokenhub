// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Apenas para que o Hardhat compile o timelock usado como admin do token em produção.
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @notice Admin do BRLZX: toda ação administrativa (upgrade, papéis, limites) é agendada pela
/// proprietária, fica pública durante o atraso e só então pode ser executada. Pode ser cancelada antes.
contract StablecoinTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors)
        TimelockController(minDelay, proposers, executors, address(0))
    {}
}
