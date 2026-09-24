// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

contract StateFixture {
  address public immutable BENEFICIARY;
  address public binding;
  address public owner;

  constructor(address beneficiary, address owner_) {
    BENEFICIARY = beneficiary;
    owner = owner_;
  }

  function setBinding(address value) external {
    require(msg.sender == owner);
    binding = value;
  }
}
