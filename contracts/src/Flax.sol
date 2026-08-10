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

/// @title FlaxYieldVault — FXRP yield strategy vault
/// @notice Receives FXRP from the FCC operator on behalf of Flax wallet users
///         (identified by the keccak256 of their XRPL classic address) and
///         accrues yield at a fixed test-rate. Yield is paid in newly minted
///         FXRP on unstake, simulating strategy returns.
contract FlaxYieldVault {
    FXRP public immutable fxrp;
    address public operator;

    /// @notice Annual yield in basis points (520 = 5.20% APY).
    uint256 public constant RATE_BPS = 520;
    uint256 private constant YEAR = 365 days;

    struct Position {
        uint256 principal;
        uint256 lastAccrued;
        uint256 accruedYield;
    }

    /// @dev key = keccak256(bytes(xrplClassicAddress))
    mapping(bytes32 => Position) public positions;
    uint256 public totalStaked;

    event Staked(bytes32 indexed user, uint256 amount, uint256 totalPrincipal);
    event Unstaked(bytes32 indexed user, uint256 amount, uint256 yieldPaid);

    modifier onlyOperator() {
        require(msg.sender == operator, "Vault: not operator");
        _;
    }

    constructor(FXRP _fxrp) {
        fxrp = _fxrp;
        operator = msg.sender;
    }

    function _accrue(Position storage p) internal {
        if (p.principal > 0 && p.lastAccrued > 0) {
            uint256 dt = block.timestamp - p.lastAccrued;
            p.accruedYield += (p.principal * RATE_BPS * dt) / (10000 * YEAR);
        }
        p.lastAccrued = block.timestamp;
    }

    function stakeFor(bytes32 user, uint256 amount) external onlyOperator {
        require(fxrp.transferFrom(msg.sender, address(this), amount), "Vault: transfer failed");
        Position storage p = positions[user];
        _accrue(p);
        p.principal += amount;
        totalStaked += amount;
        emit Staked(user, amount, p.principal);
    }

    function unstakeFor(bytes32 user, uint256 amount) external onlyOperator {
        Position storage p = positions[user];
        _accrue(p);
        require(p.principal >= amount, "Vault: insufficient principal");
        p.principal -= amount;
        totalStaked -= amount;

        uint256 yieldOut = 0;
        if (p.principal == 0) {
            yieldOut = p.accruedYield;
            p.accruedYield = 0;
        } else {
            // proportional yield payout
            yieldOut = (p.accruedYield * amount) / (p.principal + amount);
            p.accruedYield -= yieldOut;
        }

        require(fxrp.transfer(msg.sender, amount), "Vault: transfer failed");
        if (yieldOut > 0) {
            fxrp.mint(msg.sender, yieldOut, bytes32(0));
        }
        emit Unstaked(user, amount, yieldOut);
    }

    function pendingYield(bytes32 user) external view returns (uint256) {
        Position storage p = positions[user];
        uint256 acc = p.accruedYield;
        if (p.principal > 0 && p.lastAccrued > 0) {
            acc += (p.principal * RATE_BPS * (block.timestamp - p.lastAccrued)) / (10000 * YEAR);
        }
        return acc;
    }

    function principalOf(bytes32 user) external view returns (uint256) {
        return positions[user].principal;
    }
}
