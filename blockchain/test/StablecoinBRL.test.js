const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => ethers.parseUnits(String(n), 6);
const ref = (s) => ethers.id(s);
const DAY = 24 * 60 * 60;
const Z = ethers.ZeroAddress;

describe("StablecoinBRL", () => {
  let token, impl, admin, minter, treasury, pauser, compliance, reserve, alice, bob, mallory, approver;

  beforeEach(async () => {
    [admin, minter, treasury, pauser, compliance, reserve, alice, bob, mallory, approver] = await ethers.getSigners();
    const Impl = await ethers.getContractFactory("StablecoinBRL");
    impl = await Impl.deploy();
    // admin = proprietária; minter/treasury/pauser/compliance = TokenHub; reserve = proprietária
    const roles = {
      minter: minter.address, burner: treasury.address, pauser: pauser.address,
      compliance: compliance.address, reserve: reserve.address, approver: approver.address,
      unpauser: admin.address,
    };
    const init = Impl.interface.encodeFunctionData("initialize", ["BRLZX", "BRLZX", admin.address, 2 * DAY, roles]);
    const Proxy = await ethers.getContractFactory("StablecoinProxy");
    const proxy = await Proxy.deploy(await impl.getAddress(), init);
    token = Impl.attach(await proxy.getAddress());
    await token.connect(reserve).attestReserve(U(1000));
  });

  describe("configuração", () => {
    it("nome, símbolo, 6 decimais e supply zero", async () => {
      expect(await token.name()).to.equal("BRLZX");
      expect(await token.symbol()).to.equal("BRLZX");
      expect(await token.decimals()).to.equal(6);
      expect(await token.totalSupply()).to.equal(0);
    });

    it("não inicializa duas vezes, nem a implementação diretamente", async () => {
      const none = { minter: Z, burner: Z, pauser: Z, compliance: Z, reserve: Z, approver: Z, unpauser: Z };
      await expect(token.initialize("x", "x", mallory.address, 0, none)).to.be.revertedWithCustomError(token, "InvalidInitialization");
      await expect(impl.initialize("x", "x", mallory.address, 0, none)).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });
  });

  describe("emissão", () => {
    it("minter emite com referência e registra evento", async () => {
      await expect(token.connect(minter).mint(alice.address, U(100), ref("ordem-1")))
        .to.emit(token, "Minted").withArgs(alice.address, U(100), ref("ordem-1"), minter.address);
      expect(await token.balanceOf(alice.address)).to.equal(U(100));
      expect(await token.isMintRefUsed(ref("ordem-1"))).to.equal(true);
    });

    it("mesma referência não emite duas vezes", async () => {
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-1"));
      await expect(token.connect(minter).mint(alice.address, U(100), ref("ordem-1")))
        .to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");
    });

    it("rejeita valor zero e referência vazia", async () => {
      await expect(token.connect(minter).mint(alice.address, 0, ref("a"))).to.be.revertedWithCustomError(token, "ZeroAmount");
      await expect(token.connect(minter).mint(alice.address, U(1), ethers.ZeroHash)).to.be.revertedWithCustomError(token, "InvalidReference");
    });

    it("quem não é minter não emite (nem o admin)", async () => {
      await expect(token.connect(mallory).mint(mallory.address, U(1), ref("a")))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(admin).mint(admin.address, U(1), ref("a")))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("prazo de cobertura (48h)", () => {
    const H = 3600;

    it("tesouraria emite antes do lastro e o relógio começa", async () => {
      expect(await token.coverageWindow()).to.equal(48 * H);
      await token.connect(minter).mint(alice.address, U(1000), ref("ordem-1"));
      expect(await token.coverageDeadline()).to.equal(0);
      await expect(token.connect(minter).mint(alice.address, U(500), ref("ordem-2")))
        .to.emit(token, "CoverageDeficitStarted");
      expect(await token.uncoveredSupply()).to.equal(U(500));
      expect(await token.coverageDeadline()).to.equal((await time.latest()) + 48 * H);
    });

    it("dentro do prazo segue emitindo; o relógio não reinicia", async () => {
      await token.connect(minter).mint(alice.address, U(1500), ref("ordem-1"));
      const deadline = await token.coverageDeadline();
      await time.increase(47 * H);
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-2"));
      expect(await token.coverageDeadline()).to.equal(deadline);
    });

    it("vencido o prazo sem cobertura, emissão trava; transferências seguem", async () => {
      await token.connect(minter).mint(alice.address, U(1500), ref("ordem-1"));
      await time.increase(48 * H + 1);
      await expect(token.connect(minter).mint(alice.address, U(1), ref("ordem-2")))
        .to.be.revertedWithCustomError(token, "CoverageOverdue");
      await token.connect(alice).transfer(bob.address, U(10));
    });

    it("cobertura parcial não zera o relógio; integral libera", async () => {
      await token.connect(minter).mint(alice.address, U(1500), ref("ordem-1"));
      await time.increase(48 * H + 1);
      await token.connect(reserve).attestReserve(U(1400));
      await expect(token.connect(minter).mint(alice.address, U(1), ref("ordem-2")))
        .to.be.revertedWithCustomError(token, "CoverageOverdue");
      await expect(token.connect(reserve).attestReserve(U(1500))).to.emit(token, "CoverageRestored");
      expect(await token.coverageDeadline()).to.equal(0);
      await token.connect(minter).mint(alice.address, U(1), ref("ordem-2"));
    });

    it("resgate que zera o descoberto também restaura a cobertura", async () => {
      await token.connect(minter).mint(treasury.address, U(1200), ref("ordem-1"));
      await expect(token.connect(treasury).redeem(U(200), ref("resgate-1"))).to.emit(token, "CoverageRestored");
      expect(await token.uncoveredSupply()).to.equal(0);
    });

    it("reserva atestada abaixo do supply inicia o prazo", async () => {
      await token.connect(minter).mint(alice.address, U(1000), ref("ordem-1"));
      await expect(token.connect(reserve).attestReserve(U(900))).to.emit(token, "CoverageDeficitStarted");
      expect(await token.uncoveredSupply()).to.equal(U(100));
    });

    it("só o admin muda o prazo, dentro do limite", async () => {
      await expect(token.connect(mallory).setCoverageWindow(H)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.setCoverageWindow(0)).to.be.revertedWithCustomError(token, "InvalidCoverageWindow");
      await expect(token.setCoverageWindow(8 * 24 * H)).to.be.revertedWithCustomError(token, "InvalidCoverageWindow");
      await expect(token.setCoverageWindow(24 * H)).to.emit(token, "CoverageWindowChanged").withArgs(48 * H, 24 * H);
    });

    it("só RESERVE_ROLE atesta", async () => {
      await expect(token.connect(mallory).attestReserve(U(1e9))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(reserve).attestReserve(U(400)))
        .to.emit(token, "ReserveAttested").withArgs(U(1000), U(400), reserve.address);
      expect(await token.reserveUpdatedAt()).to.be.greaterThan(0);
    });
  });

  describe("dupla aprovação (total descoberto acima de R$ 100 mil)", () => {
    it("limite padrão é R$ 100 mil", async () => {
      expect(await token.dualApprovalThreshold()).to.equal(U(100000));
    });

    it("emissão coberta passa direto, sem segunda aprovação", async () => {
      await token.connect(reserve).attestReserve(U(5000000));
      await token.connect(minter).mint(alice.address, U(1000000), ref("ordem-1"));
    });

    it("descoberto até R$ 100 mil passa direto; acima exige proposta", async () => {
      // reserva de 1.000: emitir 101.000 deixa exatamente 100.000 descobertos
      await token.connect(minter).mint(alice.address, U(101000), ref("ordem-1"));
      await token.connect(reserve).attestReserve(U(101000));
      expect(await token.uncoveredPortionOf(U(100000) + 1n)).to.equal(U(100000) + 1n);
      await expect(token.connect(minter).mint(alice.address, U(100000) + 1n, ref("ordem-2")))
        .to.be.revertedWithCustomError(token, "DualApprovalRequired");
    });

    it("conta só a parcela descoberta da operação", async () => {
      await token.connect(reserve).attestReserve(U(900000));
      // 1.000.000 com 900.000 de reserva: 100.000 descobertos -> passa direto
      await token.connect(minter).mint(alice.address, U(1000000), ref("ordem-1"));
      expect(await token.uncoveredSupply()).to.equal(U(100000));
    });

    it("emissões fracionadas somam: o limite vale para o total descoberto", async () => {
      await token.connect(minter).mint(alice.address, U(61000), ref("ordem-1")); // 60 mil descobertos
      await expect(token.connect(minter).mint(alice.address, U(50000), ref("ordem-2")))
        .to.be.revertedWithCustomError(token, "DualApprovalRequired").withArgs(U(110000), U(100000));
      await token.connect(minter).mint(alice.address, U(40000), ref("ordem-2")); // total 100 mil: no limite
      await expect(token.connect(minter).mint(alice.address, 1n, ref("ordem-3")))
        .to.be.revertedWithCustomError(token, "DualApprovalRequired");
      // com a 2ª assinatura segue
      await token.connect(minter).proposeMint(alice.address, U(50000), ref("ordem-3"));
      await token.connect(approver).approveMint(ref("ordem-3"));
      // reserva recomposta: emissão direta volta a funcionar
      await token.connect(reserve).attestReserve(U(151000));
      await token.connect(minter).mint(alice.address, U(100000), ref("ordem-4"));
    });

    it("proposta + aprovação de outra carteira executa a emissão", async () => {
      await expect(token.connect(minter).proposeMint(alice.address, U(500000), ref("ordem-1")))
        .to.emit(token, "MintProposed").withArgs(ref("ordem-1"), alice.address, U(500000), minter.address);
      expect(await token.balanceOf(alice.address)).to.equal(0);
      await expect(token.connect(approver).approveMint(ref("ordem-1")))
        .to.emit(token, "MintApproved").withArgs(ref("ordem-1"), approver.address)
        .and.to.emit(token, "Minted").withArgs(alice.address, U(500000), ref("ordem-1"), minter.address);
      expect(await token.balanceOf(alice.address)).to.equal(U(500000));
      await expect(token.connect(approver).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "NoPendingMint");
    });

    it("quem propôs não aprova, mesmo tendo os dois papéis", async () => {
      await token.grantRole(await token.APPROVER_ROLE(), minter.address);
      await token.connect(minter).proposeMint(alice.address, U(500000), ref("ordem-1"));
      await expect(token.connect(minter).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "SelfApproval");
    });

    it("sem papel não propõe nem aprova; proposta não duplica", async () => {
      await expect(token.connect(mallory).proposeMint(mallory.address, U(1), ref("x"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await token.connect(minter).proposeMint(alice.address, U(500000), ref("ordem-1"));
      await expect(token.connect(minter).proposeMint(alice.address, U(1), ref("ordem-1"))).to.be.revertedWithCustomError(token, "MintAlreadyPending");
      await expect(token.connect(mallory).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(minter).mint(alice.address, U(1), ref("ordem-1"))).to.not.be.reverted; // emissão direta com a mesma ref
      await expect(token.connect(approver).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");
    });

    it("cancelamento por quem propôs ou por aprovador; terceiros não", async () => {
      await token.connect(minter).proposeMint(alice.address, U(500000), ref("ordem-1"));
      await expect(token.connect(mallory).cancelMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(minter).cancelMint(ref("ordem-1"))).to.emit(token, "MintCancelled");
      await token.connect(minter).proposeMint(alice.address, U(500000), ref("ordem-1"));
      await token.connect(approver).cancelMint(ref("ordem-1"));
      await expect(token.connect(approver).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "NoPendingMint");
    });

    it("aprovação respeita prazo de cobertura vencido, pausa e bloqueio", async () => {
      await token.connect(minter).mint(alice.address, U(1500), ref("ordem-0"));
      await token.connect(minter).proposeMint(bob.address, U(500000), ref("ordem-1"));
      await time.increase(48 * 3600 + 1);
      await expect(token.connect(approver).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "CoverageOverdue");
      await token.connect(reserve).attestReserve(U(1500));
      await token.connect(compliance).blockAccount(bob.address);
      await expect(token.connect(approver).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "AccountBlocked");
      await token.connect(compliance).unblockAccount(bob.address);
      await token.connect(pauser).pause();
      await expect(token.connect(approver).approveMint(ref("ordem-1"))).to.be.revertedWithCustomError(token, "EnforcedPause");
    });

    it("só o admin muda o limite", async () => {
      await expect(token.connect(minter).setDualApprovalThreshold(U(1e9))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.setDualApprovalThreshold(U(50000))).to.emit(token, "DualApprovalThresholdChanged").withArgs(U(100000), U(50000));
    });
  });

  describe("limites de emissão", () => {
    beforeEach(async () => { await token.connect(reserve).attestReserve(U(100000000)); });

    it("padrões: R$ 1 milhão por emissão e R$ 5 milhões por 24h", async () => {
      expect(await token.maxMintPerTx()).to.equal(U(1000000));
      expect(await token.mintLimitPerDay()).to.equal(U(5000000));
      expect(await token.mintRemainingToday()).to.equal(U(5000000));
    });

    it("emissão acima do teto por operação é recusada, direta ou aprovada", async () => {
      await expect(token.connect(minter).mint(alice.address, U(1000000) + 1n, ref("ordem-1")))
        .to.be.revertedWithCustomError(token, "MintPerTxLimitExceeded");
      await expect(token.connect(minter).proposeMint(alice.address, U(1000000) + 1n, ref("ordem-1")))
        .to.be.revertedWithCustomError(token, "MintPerTxLimitExceeded");
      // teto reduzido depois da proposta: a aprovação também respeita
      await token.connect(minter).proposeMint(alice.address, U(900000), ref("ordem-2"));
      await token.setMintLimits(U(500000), U(5000000));
      await expect(token.connect(approver).approveMint(ref("ordem-2")))
        .to.be.revertedWithCustomError(token, "MintPerTxLimitExceeded");
    });

    it("teto de 24h soma todas as emissões e zera na janela seguinte", async () => {
      for (let i = 1; i <= 5; i++) await token.connect(minter).mint(alice.address, U(1000000), ref("ordem-" + i));
      expect(await token.mintRemainingToday()).to.equal(0);
      await expect(token.connect(minter).mint(alice.address, 1n, ref("ordem-6")))
        .to.be.revertedWithCustomError(token, "DailyMintLimitExceeded");
      await time.increase(24 * 3600);
      expect(await token.mintRemainingToday()).to.equal(U(5000000));
      await token.connect(minter).mint(alice.address, U(1000000), ref("ordem-6"));
    });

    it("só o admin muda os tetos", async () => {
      await expect(token.connect(minter).setMintLimits(U(1e9), U(1e9))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.setMintLimits(U(2000000), U(8000000))).to.emit(token, "MintLimitsChanged").withArgs(U(2000000), U(8000000));
      await token.connect(minter).mint(alice.address, U(2000000), ref("ordem-1"));
    });
  });

  describe("admin atrás de timelock (configuração de produção)", () => {
    const DELAY = 48 * 3600;
    let tl, t2;

    beforeEach(async () => {
      // bob faz o papel do multisig da proprietária
      const TL = await ethers.getContractFactory("StablecoinTimelock");
      tl = await TL.deploy(DELAY, [bob.address], [bob.address]);
      const Impl = await ethers.getContractFactory("StablecoinBRL");
      const roles = { minter: minter.address, burner: treasury.address, pauser: pauser.address, compliance: compliance.address,
        reserve: reserve.address, approver: approver.address, unpauser: bob.address };
      const init = Impl.interface.encodeFunctionData("initialize", ["BRLZX", "BRLZX", await tl.getAddress(), 2 * DAY, roles]);
      const Proxy = await ethers.getContractFactory("StablecoinProxy");
      t2 = Impl.attach(await (await Proxy.deploy(await impl.getAddress(), init)).getAddress());
    });

    const op = async (data) => [await t2.getAddress(), 0, data, ethers.ZeroHash, ethers.id("sal")];

    it("o multisig não age direto: nem papel, nem upgrade, nem limite", async () => {
      await expect(t2.connect(bob).grantRole(await t2.MINTER_ROLE(), mallory.address)).to.be.revertedWithCustomError(t2, "AccessControlUnauthorizedAccount");
      await expect(t2.connect(bob).setMintLimits(U(1e12), U(1e12))).to.be.revertedWithCustomError(t2, "AccessControlUnauthorizedAccount");
      const V2 = await (await ethers.getContractFactory("StablecoinBRLV2Mock")).deploy();
      await expect(t2.connect(bob).upgradeToAndCall(await V2.getAddress(), "0x")).to.be.revertedWithCustomError(t2, "AccessControlUnauthorizedAccount");
    });

    it("ação agendada só vale depois de 48h", async () => {
      const data = t2.interface.encodeFunctionData("grantRole", [await t2.MINTER_ROLE(), alice.address]);
      const args = await op(data);
      await tl.connect(bob).schedule(...args, DELAY);
      await expect(tl.connect(bob).execute(...args)).to.be.revertedWithCustomError(tl, "TimelockUnexpectedOperationState");
      await time.increase(DELAY);
      await tl.connect(bob).execute(...args);
      expect(await t2.hasRole(await t2.MINTER_ROLE(), alice.address)).to.equal(true);
    });

    it("upgrade agendado pode ser cancelado antes do prazo", async () => {
      const V2 = await (await ethers.getContractFactory("StablecoinBRLV2Mock")).deploy();
      const args = await op(t2.interface.encodeFunctionData("upgradeToAndCall", [await V2.getAddress(), "0x"]));
      await tl.connect(bob).schedule(...args, DELAY);
      const id = await tl.hashOperation(...args);
      await tl.connect(bob).cancel(id);
      await time.increase(DELAY);
      await expect(tl.connect(bob).execute(...args)).to.be.revertedWithCustomError(tl, "TimelockUnexpectedOperationState");
    });

    it("quem não é a proprietária não agenda; atraso menor que 48h é recusado", async () => {
      const args = await op(t2.interface.encodeFunctionData("setMintLimits", [U(1e12), U(1e12)]));
      await expect(tl.connect(mallory).schedule(...args, DELAY)).to.be.revertedWithCustomError(tl, "AccessControlUnauthorizedAccount");
      await expect(tl.connect(bob).schedule(...args, DELAY - 1)).to.be.revertedWithCustomError(tl, "TimelockInsufficientDelay");
    });

    it("pausa e retomada não esperam o timelock", async () => {
      await t2.connect(pauser).pause();
      await t2.connect(bob).unpause();
      await t2.connect(bob).pause();
      expect(await t2.paused()).to.equal(true);
    });
  });

  describe("resgate", () => {
    beforeEach(async () => {
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-1"));
      await token.connect(alice).transfer(treasury.address, U(60));
    });

    it("tesouraria queima o próprio saldo com referência única", async () => {
      await expect(token.connect(treasury).redeem(U(60), ref("resgate-1")))
        .to.emit(token, "Redeemed").withArgs(treasury.address, U(60), ref("resgate-1"));
      expect(await token.totalSupply()).to.equal(U(40));
      await token.connect(alice).transfer(treasury.address, U(10));
      await expect(token.connect(treasury).redeem(U(10), ref("resgate-1")))
        .to.be.revertedWithCustomError(token, "ReferenceAlreadyUsed");
    });

    it("sem papel não resgata; não queima mais que o saldo", async () => {
      await expect(token.connect(alice).redeem(U(1), ref("r"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(treasury).redeem(U(61), ref("r"))).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  describe("bloqueio", () => {
    beforeEach(async () => {
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-1"));
      await token.connect(minter).mint(bob.address, U(100), ref("ordem-2"));
    });

    it("bloqueado não envia, não recebe e não recebe emissão", async () => {
      await token.connect(compliance).blockAccount(alice.address);
      await expect(token.connect(alice).transfer(bob.address, U(1))).to.be.revertedWithCustomError(token, "AccountBlocked");
      await expect(token.connect(bob).transfer(alice.address, U(1))).to.be.revertedWithCustomError(token, "AccountBlocked");
      await expect(token.connect(minter).mint(alice.address, U(1), ref("ordem-3"))).to.be.revertedWithCustomError(token, "AccountBlocked");
    });

    it("bloqueado não movimenta saldo de terceiros via allowance", async () => {
      await token.connect(bob).approve(alice.address, U(50));
      await token.connect(compliance).blockAccount(alice.address);
      await expect(token.connect(alice).transferFrom(bob.address, mallory.address, U(1)))
        .to.be.revertedWithCustomError(token, "AccountBlocked");
    });

    it("allowance dada antes do bloqueio não tira saldo do bloqueado", async () => {
      await token.connect(alice).approve(bob.address, U(50));
      await token.connect(compliance).blockAccount(alice.address);
      await expect(token.connect(bob).transferFrom(alice.address, bob.address, U(1)))
        .to.be.revertedWithCustomError(token, "AccountBlocked");
    });

    it("desbloqueio devolve a movimentação", async () => {
      await token.connect(compliance).blockAccount(alice.address);
      await token.connect(compliance).unblockAccount(alice.address);
      await token.connect(alice).transfer(bob.address, U(1));
      expect(await token.balanceOf(bob.address)).to.equal(U(101));
    });

    it("destrói fundos só de bloqueado, e a conta segue bloqueada", async () => {
      await expect(token.connect(compliance).destroyBlockedFunds(alice.address)).to.be.revertedWithCustomError(token, "AccountNotBlocked");
      await token.connect(compliance).blockAccount(alice.address);
      await expect(token.connect(compliance).destroyBlockedFunds(alice.address))
        .to.emit(token, "BlockedFundsDestroyed").withArgs(alice.address, U(100), compliance.address);
      expect(await token.balanceOf(alice.address)).to.equal(0);
      expect(await token.totalSupply()).to.equal(U(100));
      expect(await token.isBlocked(alice.address)).to.equal(true);
    });

    it("só COMPLIANCE_ROLE bloqueia e destrói", async () => {
      await expect(token.connect(mallory).blockAccount(alice.address)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(admin).destroyBlockedFunds(alice.address)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("pausa", () => {
    it("pausa trava transferência, emissão e resgate; só quem tem UNPAUSER_ROLE retoma", async () => {
      await token.connect(minter).mint(treasury.address, U(100), ref("ordem-1"));
      await token.connect(pauser).pause();
      await expect(token.connect(treasury).transfer(bob.address, U(1))).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(minter).mint(alice.address, U(1), ref("ordem-2"))).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(treasury).redeem(U(1), ref("r"))).to.be.revertedWithCustomError(token, "EnforcedPause");
      await expect(token.connect(pauser).unpause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await token.connect(admin).unpause();
      await token.connect(treasury).transfer(bob.address, U(1));
    });

    it("sem papel não pausa", async () => {
      await expect(token.connect(mallory).pause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });
  });

  describe("permit", () => {
    it("aprova por assinatura (EIP-2612)", async () => {
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-1"));
      const deadline = (await time.latest()) + 3600;
      const domain = {
        name: "BRLZX", version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };
      const types = { Permit: [
        { name: "owner", type: "address" }, { name: "spender", type: "address" },
        { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
      ] };
      const sig = ethers.Signature.from(await alice.signTypedData(domain, types, {
        owner: alice.address, spender: bob.address, value: U(30), nonce: 0, deadline,
      }));
      await token.connect(bob).permit(alice.address, bob.address, U(30), deadline, sig.v, sig.r, sig.s);
      await token.connect(bob).transferFrom(alice.address, bob.address, U(30));
      expect(await token.balanceOf(bob.address)).to.equal(U(30));
    });
  });

  describe("emissora x proprietária", () => {
    it("papéis saem do deploy já separados por empresa", async () => {
      expect(await token.defaultAdmin()).to.equal(admin.address);
      expect(await token.hasRole(await token.MINTER_ROLE(), minter.address)).to.equal(true);
      expect(await token.hasRole(await token.BURNER_ROLE(), treasury.address)).to.equal(true);
      expect(await token.hasRole(await token.COMPLIANCE_ROLE(), compliance.address)).to.equal(true);
      expect(await token.hasRole(await token.RESERVE_ROLE(), reserve.address)).to.equal(true);
      expect(await token.hasRole(await token.MINTER_ROLE(), admin.address)).to.equal(false);
      expect(await token.hasRole(await token.RESERVE_ROLE(), minter.address)).to.equal(false);
    });

    it("emissora não concede papéis, não atesta reserva, não despausa e não faz upgrade", async () => {
      await expect(token.connect(minter).grantRole(await token.MINTER_ROLE(), mallory.address)).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(minter).attestReserve(U(1e9))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await token.connect(pauser).pause();
      await expect(token.connect(minter).unpause()).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await expect(token.connect(minter).upgradeToAndCall(await impl.getAddress(), "0x")).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
    });

    it("proprietária também pausa", async () => {
      await token.connect(admin).pause();
      expect(await token.paused()).to.equal(true);
    });

    it("proprietária troca a emissora sem mudar o token", async () => {
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-1"));
      const addr = await token.getAddress();
      for (const [role, who] of [["MINTER_ROLE", minter], ["BURNER_ROLE", treasury], ["PAUSER_ROLE", pauser], ["COMPLIANCE_ROLE", compliance]]) {
        await token.revokeRole(await token[role](), who.address);
      }
      await token.grantRole(await token.MINTER_ROLE(), bob.address); // nova emissora
      await expect(token.connect(minter).mint(alice.address, U(1), ref("ordem-2"))).to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await token.connect(bob).mint(alice.address, U(1), ref("ordem-2"));
      expect(await token.getAddress()).to.equal(addr);
      expect(await token.balanceOf(alice.address)).to.equal(U(101));
    });
  });

  describe("administração e upgrade", () => {
    it("troca de admin exige o atraso configurado", async () => {
      await token.connect(admin).beginDefaultAdminTransfer(bob.address);
      await expect(token.connect(bob).acceptDefaultAdminTransfer()).to.be.revertedWithCustomError(token, "AccessControlEnforcedDefaultAdminDelay");
      await time.increase(2 * DAY + 1);
      await token.connect(bob).acceptDefaultAdminTransfer();
      expect(await token.defaultAdmin()).to.equal(bob.address);
    });

    it("só o admin faz upgrade, e o estado é preservado", async () => {
      await token.connect(minter).mint(alice.address, U(100), ref("ordem-1"));
      await token.connect(compliance).blockAccount(bob.address);
      const V2 = await ethers.getContractFactory("StablecoinBRLV2Mock");
      const v2 = await V2.deploy();
      await expect(token.connect(mallory).upgradeToAndCall(await v2.getAddress(), "0x"))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount");
      await token.connect(admin).upgradeToAndCall(await v2.getAddress(), "0x");
      const upgraded = V2.attach(await token.getAddress());
      expect(await upgraded.version()).to.equal("v2");
      expect(await upgraded.balanceOf(alice.address)).to.equal(U(100));
      expect(await upgraded.isBlocked(bob.address)).to.equal(true);
      expect(await upgraded.isMintRefUsed(ref("ordem-1"))).to.equal(true);
      expect(await upgraded.attestedReserve()).to.equal(U(1000));
    });
  });
});
