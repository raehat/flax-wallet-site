// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title FXRP — FAssets-style wrapped XRP (Coston2 test deployment)
/// @notice Minted/burned by the Flare Confidential Compute operator when
///         custody XRP is wrapped/unwrapped. 1 FXRP == 1 XRP (6 -> 18 decimals).
contract FXRP {
    string public constant name = "Flare Wrapped XRP";
    string public constant symbol = "FXRP";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public owner;
    mapping(address => bool) public minters;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Minted(address indexed to, uint256 value, bytes32 indexed xrplRef);
    event Burned(address indexed from, uint256 value, bytes32 indexed xrplRef);

    modifier onlyMinter() {
        require(msg.sender == owner || minters[msg.sender], "FXRP: not authorized");
        _;
    }

    constructor() {
        owner = msg.sender;
        minters[msg.sender] = true;
    }

    function setMinter(address account, bool allowed) external {
        require(msg.sender == owner, "FXRP: not owner");
        minters[account] = allowed;
    }

    /// @param xrplRef Hash reference of the underlying XRPL custody transaction.
    function mint(address to, uint256 value, bytes32 xrplRef) external onlyMinter {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
        emit Minted(to, value, xrplRef);
    }

    function burn(address from, uint256 value, bytes32 xrplRef) external onlyMinter {
        require(balanceOf[from] >= value, "FXRP: insufficient");
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
        emit Burned(from, value, xrplRef);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "FXRP: insufficient");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        require(balanceOf[from] >= value, "FXRP: insufficient");
        require(allowance[from][msg.sender] >= value, "FXRP: allowance");
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
