// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Apenas para que o Hardhat compile o proxy usado no deploy e nos testes.
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

contract StablecoinProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data) ERC1967Proxy(implementation, data) {}
}
