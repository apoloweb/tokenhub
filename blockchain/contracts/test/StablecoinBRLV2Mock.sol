// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StablecoinBRL} from "../StablecoinBRL.sol";

/// @dev Só para testar o upgrade. Não usar em produção.
contract StablecoinBRLV2Mock is StablecoinBRL {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
