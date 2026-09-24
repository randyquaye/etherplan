// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

library Doubler {
    function twice(uint256 value) external pure returns (uint256) {
        return value * 2;
    }
}

contract Sample {
    address public immutable UPSTREAM;
    bytes32 public immutable LABEL;
    address private immutable SELF;
    address public binding;
    uint256 public stored;

    constructor(address upstream, bytes32 label) {
        UPSTREAM = upstream;
        LABEL = label;
        SELF = address(this);
        stored = 7;
    }

    function self() external view returns (address) {
        return SELF;
    }

    function bind(address next) external {
        binding = next;
    }
}

contract Stamped {
    uint256 public immutable CREATED_AT;
    uint256 public immutable SEED;

    constructor(uint256 seed) {
        CREATED_AT = block.timestamp;
        SEED = seed;
    }
}

contract Linked {
    uint256 public immutable SEED;

    constructor(uint256 seed) {
        SEED = Doubler.twice(seed);
    }

    function doubled(uint256 value) external pure returns (uint256) {
        return Doubler.twice(value);
    }
}
