// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";

/// @title StablecoinBRL
/// @notice Stablecoin lastreada 1:1 em reais, de circulação pública.
/// @dev
///  - Emissão (mint) só por MINTER_ROLE, sempre vinculada a uma referência única: o ID da ordem
///    de emissão no backoffice, qualquer que seja o meio de pagamento (Pix, TED, boleto,
///    transferência interna, dinheiro). A mesma referência não emite duas vezes.
///  - Prazo de cobertura: a tesouraria pode emitir antes de o lastro estar constituído, mas tem
///    um prazo (padrão 48h) para atestar reserva >= supply. Vencido o prazo sem cobertura,
///    novas emissões ficam travadas até a reserva ser recomposta.
///  - Dupla aprovação: emissão que deixe o total descoberto acumulado acima do limite (padrão
///    R$ 100 mil) não pode ser feita direto; precisa ser proposta por um MINTER e aprovada por outra carteira (APPROVER_ROLE).
///  - Limites de emissão: teto por operação e teto por janela de 24h, valendo para emissão direta e
///    aprovada. Limitam o estrago se uma carteira de emissão (e a de aprovação) for comprometida.
///  - Resgate (burn) só por BURNER_ROLE, a partir do próprio saldo (tesouraria), com referência única.
///  - Bloqueio de endereços e destruição de fundos bloqueados por COMPLIANCE_ROLE.
///  - Pausa geral por PAUSER_ROLE; retomada por UNPAUSER_ROLE.
///  - Upgrade (UUPS), concessão de papéis e mudança de limites só pelo admin. Em produção o admin é
///    um TimelockController: toda ação administrativa fica pública e em espera (padrão 48h) antes de
///    valer, e pode ser cancelada nesse intervalo. Ver scripts/deploy.js.
contract StablecoinBRL is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20PausableUpgradeable,
    AccessControlDefaultAdminRulesUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant COMPLIANCE_ROLE = keccak256("COMPLIANCE_ROLE");
    bytes32 public constant RESERVE_ROLE = keccak256("RESERVE_ROLE");
    bytes32 public constant APPROVER_ROLE = keccak256("APPROVER_ROLE");
    bytes32 public constant UNPAUSER_ROLE = keccak256("UNPAUSER_ROLE");

    /// @notice Carteiras que recebem os papéis operacionais no deploy (endereço zero = não conceder).
    struct InitialRoles {
        address minter; // emissora
        address burner; // tesouraria da emissora
        address pauser; // emissora
        address compliance; // emissora
        address reserve; // proprietária (titular do lastro)
        address approver; // segunda assinatura das emissões descobertas acima do limite
        address unpauser; // proprietária: retoma o contrato depois de uma pausa (e também pode pausar)
    }

    struct PendingMint {
        address to;
        uint256 amount;
        address proposer;
    }

    /// @custom:storage-location erc7201:tokenhub.storage.StablecoinBRL
    struct StablecoinStorage {
        mapping(address => bool) blocked;
        mapping(bytes32 => bool) usedMintRef;
        mapping(bytes32 => bool) usedBurnRef;
        uint256 attestedReserve; // lastro atestado, na mesma unidade do token
        uint64 reserveUpdatedAt;
        uint64 deficitSince; // início do período descoberto (0 = totalmente coberto)
        uint64 coverageWindow; // prazo para cobrir o supply emitido, em segundos
        uint256 dualApprovalThreshold; // total descoberto acumulado acima do qual a emissão exige 2ª aprovação
        mapping(bytes32 => PendingMint) pendingMints;
        uint256 maxMintPerTx; // teto por emissão
        uint256 mintLimitPerDay; // teto por janela de 24h
        uint256 mintedInWindow;
        uint64 mintWindowStart;
    }

    uint64 public constant MAX_COVERAGE_WINDOW = 7 days;

    // keccak256(abi.encode(uint256(keccak256("tokenhub.storage.StablecoinBRL")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x5be692344bbdf15624c32a411349528c80c01255b168b2cbc70585a84b989600;

    event Minted(address indexed to, uint256 amount, bytes32 indexed ref, address indexed operator);
    event Redeemed(address indexed from, uint256 amount, bytes32 indexed ref);
    event Blocked(address indexed account, address indexed operator);
    event Unblocked(address indexed account, address indexed operator);
    event BlockedFundsDestroyed(address indexed account, uint256 amount, address indexed operator);
    event ReserveAttested(uint256 previousReserve, uint256 newReserve, address indexed operator);
    event CoverageDeficitStarted(uint256 uncovered, uint64 deadline);
    event CoverageRestored();
    event CoverageWindowChanged(uint64 previousWindow, uint64 newWindow);
    event MintProposed(bytes32 indexed ref, address indexed to, uint256 amount, address indexed proposer);
    event MintApproved(bytes32 indexed ref, address indexed approver);
    event MintCancelled(bytes32 indexed ref, address indexed operator);
    event DualApprovalThresholdChanged(uint256 previousThreshold, uint256 newThreshold);
    event MintLimitsChanged(uint256 maxPerTx, uint256 perDay);

    error AccountBlocked(address account);
    error AccountNotBlocked(address account);
    error ReferenceAlreadyUsed(bytes32 ref);
    error InvalidReference();
    error ZeroAmount();
    error CoverageOverdue(uint256 uncovered, uint64 deadline);
    error InvalidCoverageWindow();
    error DualApprovalRequired(uint256 uncoveredAfterMint, uint256 threshold);
    error MintAlreadyPending(bytes32 ref);
    error NoPendingMint(bytes32 ref);
    error SelfApproval();
    error MintPerTxLimitExceeded(uint256 amount, uint256 limit);
    error DailyMintLimitExceeded(uint256 mintedAfter, uint256 limit);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param name_ Nome do token
    /// @param symbol_ Símbolo do token
    /// @param admin Admin: a proprietária do token (recomendado: multisig)
    /// @param adminDelay Atraso, em segundos, para troca do admin
    /// @param roles Carteiras operacionais iniciais; o admin pode revogar e reatribuir depois,
    ///        inclusive para trocar de emissora sem mudar o token.
    function initialize(
        string memory name_,
        string memory symbol_,
        address admin,
        uint48 adminDelay,
        InitialRoles calldata roles
    ) external initializer {
        __ERC20_init(name_, symbol_);
        __ERC20Permit_init(name_);
        __ERC20Pausable_init();
        __AccessControlDefaultAdminRules_init(adminDelay, admin);
        _s().coverageWindow = 48 hours;
        _s().dualApprovalThreshold = 100_000 * 10 ** 6; // R$ 100 mil
        _s().maxMintPerTx = 50_000_000 * 10 ** 6; // R$ 50 milhões por emissão
        _s().mintLimitPerDay = 250_000_000 * 10 ** 6; // R$ 250 milhões por 24h
        if (roles.minter != address(0)) _grantRole(MINTER_ROLE, roles.minter);
        if (roles.burner != address(0)) _grantRole(BURNER_ROLE, roles.burner);
        if (roles.pauser != address(0)) _grantRole(PAUSER_ROLE, roles.pauser);
        if (roles.compliance != address(0)) _grantRole(COMPLIANCE_ROLE, roles.compliance);
        if (roles.reserve != address(0)) _grantRole(RESERVE_ROLE, roles.reserve);
        if (roles.approver != address(0)) _grantRole(APPROVER_ROLE, roles.approver);
        if (roles.unpauser != address(0)) {
            _grantRole(UNPAUSER_ROLE, roles.unpauser);
            _grantRole(PAUSER_ROLE, roles.unpauser); // a proprietária também pode pausar
        }
    }

    function _s() private pure returns (StablecoinStorage storage $) {
        bytes32 slot = STORAGE_LOCATION;
        assembly {
            $.slot := slot
        }
    }

    /// @notice 6 casas decimais (1 real = 1_000_000 unidades).
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ───────────── Emissão e resgate ─────────────

    /// @notice Emite tokens direto. O lastro deve ser atestado dentro do prazo de cobertura.
    /// @dev Reverte se, depois desta emissão, o total descoberto acumulado passar do limite de dupla aprovação.
    /// @param ref Referência única da ordem de emissão no backoffice (ex.: keccak256 do ID da ordem).
    function mint(address to, uint256 amount, bytes32 ref) external onlyRole(MINTER_ROLE) {
        _validateMint(amount, ref);
        StablecoinStorage storage $ = _s();
        uint256 uncoveredAfter = uncoveredSupply() + uncoveredPortionOf(amount);
        if (uncoveredAfter > $.dualApprovalThreshold) {
            revert DualApprovalRequired(uncoveredAfter, $.dualApprovalThreshold);
        }
        _executeMint(to, amount, ref, _msgSender());
    }

    /// @notice Propõe uma emissão que precisa de segunda aprovação.
    function proposeMint(address to, uint256 amount, bytes32 ref) external onlyRole(MINTER_ROLE) {
        _validateMint(amount, ref);
        StablecoinStorage storage $ = _s();
        if ($.pendingMints[ref].proposer != address(0)) revert MintAlreadyPending(ref);
        if (amount > $.maxMintPerTx) revert MintPerTxLimitExceeded(amount, $.maxMintPerTx);
        if ($.blocked[to]) revert AccountBlocked(to);
        $.pendingMints[ref] = PendingMint(to, amount, _msgSender());
        emit MintProposed(ref, to, amount, _msgSender());
    }

    /// @notice Aprova e executa uma emissão proposta. Quem propôs não pode aprovar.
    function approveMint(bytes32 ref) external onlyRole(APPROVER_ROLE) {
        StablecoinStorage storage $ = _s();
        PendingMint memory p = $.pendingMints[ref];
        if (p.proposer == address(0)) revert NoPendingMint(ref);
        if (p.proposer == _msgSender()) revert SelfApproval();
        delete $.pendingMints[ref];
        _validateMint(p.amount, ref);
        emit MintApproved(ref, _msgSender());
        _executeMint(p.to, p.amount, ref, p.proposer);
    }

    /// @notice Cancela uma emissão proposta (quem propôs ou um aprovador).
    function cancelMint(bytes32 ref) external {
        StablecoinStorage storage $ = _s();
        address proposer = $.pendingMints[ref].proposer;
        if (proposer == address(0)) revert NoPendingMint(ref);
        if (_msgSender() != proposer) _checkRole(APPROVER_ROLE);
        delete $.pendingMints[ref];
        emit MintCancelled(ref, _msgSender());
    }

    function pendingMint(bytes32 ref) external view returns (address to, uint256 amount, address proposer) {
        PendingMint storage p = _s().pendingMints[ref];
        return (p.to, p.amount, p.proposer);
    }

    /// @notice Quanto de uma emissão de `amount` ficaria sem lastro atestado neste momento.
    function uncoveredPortionOf(uint256 amount) public view returns (uint256) {
        uint256 supplyAfter = totalSupply() + amount;
        uint256 reserve = _s().attestedReserve;
        uint256 uncoveredAfter = supplyAfter > reserve ? supplyAfter - reserve : 0;
        return uncoveredAfter - uncoveredSupply();
    }

    function dualApprovalThreshold() external view returns (uint256) {
        return _s().dualApprovalThreshold;
    }

    function setDualApprovalThreshold(uint256 newThreshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StablecoinStorage storage $ = _s();
        emit DualApprovalThresholdChanged($.dualApprovalThreshold, newThreshold);
        $.dualApprovalThreshold = newThreshold;
    }

    /// @notice Altera os tetos de emissão (por operação e por janela de 24h).
    function setMintLimits(uint256 maxPerTx, uint256 perDay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        StablecoinStorage storage $ = _s();
        $.maxMintPerTx = maxPerTx;
        $.mintLimitPerDay = perDay;
        emit MintLimitsChanged(maxPerTx, perDay);
    }

    function maxMintPerTx() external view returns (uint256) {
        return _s().maxMintPerTx;
    }

    function mintLimitPerDay() external view returns (uint256) {
        return _s().mintLimitPerDay;
    }

    /// @notice Quanto ainda pode ser emitido na janela de 24h em curso.
    function mintRemainingToday() external view returns (uint256) {
        StablecoinStorage storage $ = _s();
        uint256 used = block.timestamp >= $.mintWindowStart + 1 days ? 0 : $.mintedInWindow;
        return used >= $.mintLimitPerDay ? 0 : $.mintLimitPerDay - used;
    }

    function _validateMint(uint256 amount, bytes32 ref) private view {
        if (amount == 0) revert ZeroAmount();
        if (ref == bytes32(0)) revert InvalidReference();
        StablecoinStorage storage $ = _s();
        if ($.usedMintRef[ref]) revert ReferenceAlreadyUsed(ref);
        if ($.deficitSince != 0 && block.timestamp > $.deficitSince + $.coverageWindow) {
            revert CoverageOverdue(totalSupply() - $.attestedReserve, $.deficitSince + $.coverageWindow);
        }
    }

    function _executeMint(address to, uint256 amount, bytes32 ref, address operator) private {
        StablecoinStorage storage $ = _s();
        if (amount > $.maxMintPerTx) revert MintPerTxLimitExceeded(amount, $.maxMintPerTx);
        if (block.timestamp >= $.mintWindowStart + 1 days) {
            $.mintWindowStart = uint64(block.timestamp);
            $.mintedInWindow = 0;
        }
        uint256 mintedAfter = $.mintedInWindow + amount;
        if (mintedAfter > $.mintLimitPerDay) revert DailyMintLimitExceeded(mintedAfter, $.mintLimitPerDay);
        $.mintedInWindow = mintedAfter;
        $.usedMintRef[ref] = true;
        _mint(to, amount);
        emit Minted(to, amount, ref, operator);
        _syncCoverage();
    }

    /// @notice Queima tokens do saldo do chamador (tesouraria) para liquidar um resgate em reais.
    /// @param ref Referência única do resgate (ex.: keccak256 do ID do pedido de resgate).
    function redeem(uint256 amount, bytes32 ref) external onlyRole(BURNER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        if (ref == bytes32(0)) revert InvalidReference();
        StablecoinStorage storage $ = _s();
        if ($.usedBurnRef[ref]) revert ReferenceAlreadyUsed(ref);
        $.usedBurnRef[ref] = true;
        _burn(_msgSender(), amount);
        emit Redeemed(_msgSender(), amount, ref);
        _syncCoverage();
    }

    // ───────────── Reserva ─────────────

    /// @notice Registra o lastro atestado (saldo em conta + títulos públicos), na unidade do token.
    /// @dev Se ficar abaixo do supply, o prazo de cobertura começa (ou continua) a correr.
    function attestReserve(uint256 newReserve) external onlyRole(RESERVE_ROLE) {
        StablecoinStorage storage $ = _s();
        emit ReserveAttested($.attestedReserve, newReserve, _msgSender());
        $.attestedReserve = newReserve;
        $.reserveUpdatedAt = uint64(block.timestamp);
        _syncCoverage();
    }

    /// @notice Altera o prazo de cobertura. Vale também para um período descoberto em curso.
    function setCoverageWindow(uint64 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newWindow == 0 || newWindow > MAX_COVERAGE_WINDOW) revert InvalidCoverageWindow();
        StablecoinStorage storage $ = _s();
        emit CoverageWindowChanged($.coverageWindow, newWindow);
        $.coverageWindow = newWindow;
    }

    function coverageWindow() external view returns (uint64) {
        return _s().coverageWindow;
    }

    /// @notice Supply em circulação ainda sem lastro atestado.
    function uncoveredSupply() public view returns (uint256) {
        uint256 supply = totalSupply();
        uint256 reserve = _s().attestedReserve;
        return supply > reserve ? supply - reserve : 0;
    }

    /// @notice Data-limite para cobrir o supply descoberto (0 se estiver tudo coberto).
    function coverageDeadline() external view returns (uint64) {
        StablecoinStorage storage $ = _s();
        return $.deficitSince == 0 ? 0 : $.deficitSince + $.coverageWindow;
    }

    /// @dev O relógio começa no primeiro instante descoberto e só zera com cobertura integral.
    function _syncCoverage() private {
        StablecoinStorage storage $ = _s();
        uint256 uncovered = uncoveredSupply();
        if (uncovered == 0) {
            if ($.deficitSince != 0) {
                $.deficitSince = 0;
                emit CoverageRestored();
            }
        } else if ($.deficitSince == 0) {
            $.deficitSince = uint64(block.timestamp);
            emit CoverageDeficitStarted(uncovered, uint64(block.timestamp) + $.coverageWindow);
        }
    }

    function attestedReserve() external view returns (uint256) {
        return _s().attestedReserve;
    }

    function reserveUpdatedAt() external view returns (uint64) {
        return _s().reserveUpdatedAt;
    }

    // ───────────── Compliance ─────────────

    function blockAccount(address account) external onlyRole(COMPLIANCE_ROLE) {
        _s().blocked[account] = true;
        emit Blocked(account, _msgSender());
    }

    function unblockAccount(address account) external onlyRole(COMPLIANCE_ROLE) {
        _s().blocked[account] = false;
        emit Unblocked(account, _msgSender());
    }

    /// @notice Destrói o saldo de um endereço bloqueado (ex.: ordem judicial).
    /// @dev O lastro correspondente deve ser tratado fora da rede conforme a ordem recebida.
    function destroyBlockedFunds(address account) external onlyRole(COMPLIANCE_ROLE) {
        StablecoinStorage storage $ = _s();
        if (!$.blocked[account]) revert AccountNotBlocked(account);
        uint256 amount = balanceOf(account);
        if (amount == 0) revert ZeroAmount();
        $.blocked[account] = false;
        _burn(account, amount);
        $.blocked[account] = true;
        emit BlockedFundsDestroyed(account, amount, _msgSender());
        _syncCoverage();
    }

    function isBlocked(address account) external view returns (bool) {
        return _s().blocked[account];
    }

    function isMintRefUsed(bytes32 ref) external view returns (bool) {
        return _s().usedMintRef[ref];
    }

    function isRedeemRefUsed(bytes32 ref) external view returns (bool) {
        return _s().usedBurnRef[ref];
    }

    // ───────────── Pausa ─────────────

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(UNPAUSER_ROLE) {
        _unpause();
    }

    // ───────────── Internos ─────────────

    /// @dev Endereços bloqueados não enviam, não recebem e não movimentam saldo de terceiros.
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20Upgradeable, ERC20PausableUpgradeable)
    {
        StablecoinStorage storage $ = _s();
        if ($.blocked[from]) revert AccountBlocked(from);
        if ($.blocked[to]) revert AccountBlocked(to);
        address sender = _msgSender();
        if ($.blocked[sender]) revert AccountBlocked(sender);
        super._update(from, to, value);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
