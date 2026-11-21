"""Teste de ponta a ponta das telas do BRLZX: navegador real + SQL real + contrato real, tudo local.

Sobe nada sozinho; espera encontrar:
  - Postgres local com db/tests/supabase-shim.sql, db/admin-setup.sql e db/brlzx.sql aplicados (PGHOST/PGPORT/PGUSER/PGDATABASE)
  - `npx hardhat node` em 127.0.0.1:8545 com HARDHAT_CHAIN_ID=137 e o contrato publicado (CONTRACT=0x...)
  - o site servido em http://localhost:4189  (python -m http.server 4189)

As chamadas ao Supabase são atendidas por um PostgREST mínimo (abaixo) que executa no Postgres local
com o papel `authenticated` e o usuário do token — ou seja, RLS e funções valem de verdade.
As chamadas à rede (leitura e carteira) são encaminhadas ao nó Hardhat local.
"""
import json, os, re, subprocess, sys, urllib.request
from urllib.parse import urlparse, parse_qsl
from playwright.sync_api import sync_playwright

SITE = 'http://localhost:4189'
NODE = 'http://127.0.0.1:8545'
CONTRACT = os.environ['CONTRACT'].lower()
# contas do nó Hardhat
W_OP, W_OWN, W_ALICE, W_OTHER = (a.lower() for a in (
    '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
    '0x90F79bf6EB2c4f870365E785982E1f101E93b906', '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'))
U = {'admin': '00000000-0000-0000-0000-00000000000a', 'op': '00000000-0000-0000-0000-0000000000e1',
     'own': '00000000-0000-0000-0000-0000000000b1', 'alice': '00000000-0000-0000-0000-0000000000c1'}
EMAIL = {'admin': 'admin@tokenhub.test', 'op': 'operador@tokenhub.test', 'own': 'diretor@proprietaria.test', 'alice': 'alice@cliente.test'}
WALLET = {'admin': W_OTHER, 'op': W_OP, 'own': W_OWN, 'alice': W_ALICE}


def psql(sql):
    r = subprocess.run(['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', sql], capture_output=True, text=True)
    if r.returncode != 0:
        m = re.search(r'ERROR:\s+(.*)', r.stderr)
        raise RuntimeError(m.group(1) if m else r.stderr.strip())
    return r.stdout.strip()


def lit(v):
    if v is None: return 'null'
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, (int, float)): return str(v)
    if isinstance(v, list): return 'array[' + ','.join(lit(x) for x in v) + ']::uuid[]'
    if isinstance(v, dict): return "'" + json.dumps(v).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"


def as_user(uid, query):
    pre = "begin; set local role authenticated; select set_config('request.jwt.claim.sub', %s, true);" % lit(uid or '')
    out = psql(pre + query + '; commit;')
    return out.split('\n')[-1] if out else 'null'


def postgrest(method, url, body, token):
    uid = token[4:] if token.startswith('tok-') else None
    u = urlparse(url); path = u.path.split('/rest/v1/')[1]; q = parse_qsl(u.query)
    if path.startswith('rpc/'):
        fn = path[4:]; args = json.loads(body or '{}')
        if not re.fullmatch(r'[a-z_]+', fn): raise RuntimeError('função inválida')
        call = 'public.%s(%s)' % (fn, ', '.join('%s => %s' % (k, lit(v)) for k, v in args.items()))
        setof = psql("select bool_or(proretset) from pg_proc where proname = %s" % lit(fn)) == 't'
        if setof: return as_user(uid, "select coalesce(json_agg(t), '[]')::jsonb::text from %s t" % call)
        return as_user(uid, 'select to_json(x)::jsonb::text from (select %s as x) q' % call)
    if method != 'GET' or not re.fullmatch(r'[a-z_]+', path): return '[]'
    if psql("select to_regclass('public.%s') is not null" % path) != 't': return '[]'
    where, order, limit = [], '', ''
    for k, v in q:
        if k == 'select': continue
        if k == 'order': order = ' order by ' + ', '.join(p.replace('.', ' ') for p in v.split(','))
        elif k == 'limit': limit = ' limit %d' % int(v)
        elif v.startswith('eq.'): where.append('%s = %s' % (k, lit(v[3:])))
        elif v == 'is.true': where.append('%s is true' % k)
    sql = 'select * from public.%s' % path + (' where ' + ' and '.join(where) if where else '') + order + limit
    return as_user(uid, "select coalesce(json_agg(t), '[]')::jsonb::text from (%s) t" % sql)


def node(payload):
    req = urllib.request.Request(NODE, data=payload if isinstance(payload, bytes) else json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    return urllib.request.urlopen(req).read()


def chain_call(sig, *args):
    """Lê o contrato pelo nó (via cast-like helper do próprio hardhat console seria pesado; usa eth_call cru)."""
    out = subprocess.run(['node', '-e', '''
const {ethers}=require(process.env.ETHERS);
(async()=>{const p=new ethers.JsonRpcProvider(process.argv[1]);const c=new ethers.Contract(process.argv[2],["function "+process.argv[3]],p);
const name=process.argv[3].split("(")[0];const r=await c[name](...process.argv.slice(4));console.log(r.toString());})();''', NODE, CONTRACT, sig, *args],
        capture_output=True, text=True, env={**os.environ, 'ETHERS': os.environ.get('ETHERS', 'ethers')})
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()


def handler(route):
    req = route.request; url = req.url
    try:
        if '/rest/v1/' in url:
            token = (req.headers.get('authorization') or '').replace('Bearer ', '')
            try:
                route.fulfill(status=200, content_type='application/json', body=postgrest(req.method, url, req.post_data, token))
            except RuntimeError as e:
                route.fulfill(status=400, content_type='application/json', body=json.dumps({'message': str(e)}))
        elif 'polygon-rpc.com' in url or 'wallet.local' in url:
            route.fulfill(status=200, content_type='application/json', body=node(req.post_data_buffer))
        elif url.startswith(SITE):
            route.continue_()
        elif 'supabase.co' in url:
            route.fulfill(status=200, content_type='application/json', body='[]')
        else:
            route.abort()
    except Exception as e:  # noqa
        print('handler', url, e, file=sys.stderr); route.abort()


def session(ctx, who):
    ctx.add_init_script("""
      try { localStorage.setItem('tokenhub:auth', JSON.stringify({access_token:'tok-%s', refresh_token:'r', expires_at: 4102444800, user:{id:'%s', email:'%s'}})); } catch (e) { /* about:blank */ }
      window.ethereum = { request: async ({method, params}) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['%s'];
        if (method === 'wallet_switchEthereumChain') return null;
        const r = await fetch('https://wallet.local/', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})});
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
        return j.result;
      }};""" % (U[who], U[who], EMAIL[who], WALLET[who]))


class Actor:
    def __init__(self, browser, who, mobile=False):
        self.who = who
        self.ctx = browser.new_context(viewport={'width': 390, 'height': 800} if mobile else {'width': 1280, 'height': 900})
        session(self.ctx, who)
        self.ctx.route('**/*', handler)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))
        self.dialogs = []; self.dismiss_next = False
        self.page.on('dialog', self._dialog)

    def _dialog(self, d):
        self.dialogs.append(d.message)
        if self.dismiss_next: self.dismiss_next = False; d.dismiss()
        elif d.type == 'prompt': d.accept('Teste e2e')
        else: d.accept()

    def open(self, route):
        self.page.goto('about:blank')      # força recarga mesmo quando a rota é a mesma
        self.page.goto(SITE + '/#' + route)
        self.page.wait_for_selector('#brlzx-root')
        self.settle()
        return self

    def settle(self):
        self.page.wait_for_function("!document.querySelector('#brlzx-content')?.textContent.includes('Carregando') && !document.querySelector('#brlzx-root [data-busy]')", timeout=60000)

    def tab(self, name):
        self.page.click(f'#brlzx-root [data-tab="{name}"]'); self.page.wait_for_timeout(150); self.settle(); return self

    def fill(self, form, **fields):
        f = self.page.locator(f'#brlzx-root form[data-form="{form}"]:not([data-manual])').first
        for k, v in fields.items():
            el = f.locator(f'[name="{k}"]')
            if el.evaluate('e => e.tagName') == 'SELECT': el.select_option(v)
            else: el.fill(v)
        f.locator('button:not([type="button"])').first.click()
        self.page.wait_for_timeout(150); self.settle()
        return self

    def click(self, selector):
        self.page.locator('#brlzx-root ' + selector).first.click(); self.page.wait_for_timeout(150); self.settle(); return self

    def text(self): return self.page.inner_text('#brlzx-root')
    def msg(self): return self.page.inner_text('#brlzx-msg')

    def expect(self, needle, where=None):
        t = where if where is not None else self.text()
        assert needle in t, f'[{self.who}] esperava "{needle}" em:\n{t[:1500]}'
        return self

    def refuse(self, needle):
        assert needle not in self.text(), f'[{self.who}] NÃO esperava "{needle}"'
        return self


def main():
    for k in U:
        psql("insert into auth.users (id, email) values (%s, %s) on conflict do nothing" % (lit(U[k]), lit(EMAIL[k])))
    psql("update public.profiles set role = 'admin' where id = %s" % lit(U['admin']))
    shots = os.environ.get('SHOTS')
    with sync_playwright() as pw:
        b = pw.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
        admin, op, own, alice = Actor(b, 'admin'), Actor(b, 'op'), Actor(b, 'own'), Actor(b, 'alice', mobile=True)

        # 0) cliente sem equipe não entra no backoffice; contrato ainda não configurado
        alice.open('/app/brlzx/backoffice').expect('Acesso restrito')
        alice.open('/app/brlzx').expect('ainda não foi publicado')

        # 1) admin do TokenHub monta a equipe e a rede
        admin.open('/app/brlzx/backoffice').expect('Equipe').refuse('Auditoria')
        admin.fill('member', email=EMAIL['op'], org='emissora').expect('incluída', admin.msg())
        admin.fill('member', email=EMAIL['own'], org='proprietaria').expect('incluída', admin.msg())
        admin.refuse('Proprietária</option>')
        assert admin.page.locator('form[data-form="member"] option[value="proprietaria"]').count() == 0, 'admin não inclui 2º membro da proprietária'
        admin.fill('network', chain='137', contract=CONTRACT, treasury=W_OP).expect('salva', admin.msg())

        # 2) emissora não vê formulário de depósito nem de atestação
        op.open('/app/brlzx/backoffice').expect('TokenHub (emissora)')
        op.tab('equipe'); assert op.page.locator('form[data-form="deposit"]').count() == 0
        op.tab('cobertura').expect('feita pela proprietária'); assert op.page.locator('form[data-form="attest"]').count() == 0

        # 3) proprietária informa a conta e atesta a reserva (R$ 800 mil)
        own.open('/app/brlzx/backoffice').expect('Proprietária')
        own.tab('equipe').fill('deposit', owner_name='Proprietária Teste S.A.', deposit_pix_key='reserva@proprietaria.test', deposit_holder='Proprietária Teste S.A.')
        own.expect('salvos', own.msg())
        own.tab('cobertura').fill('attest', cash='400.000,00', bonds='400.000,00', note='Extrato + Tesouro Selic')
        own.expect('Reserva atestada', own.msg()).expect('800.000,00').expect('Tudo coberto').expect('Teto por emissão')
        assert chain_call('attestedReserve() view returns (uint256)') == str(800_000 * 10**6)

        # 4) cliente cadastra carteira e pede emissão de R$ 50 mil
        alice.open('/app/brlzx').expect('Proprietária Teste S.A.').expect('reserva@proprietaria.test').refuse('Abrir backoffice')
        alice.fill('add-wallet', address='0x123').expect('inválido', alice.msg())
        alice.click('[data-act="use-browser-wallet"]')
        alice.fill('add-wallet', label='Minha carteira').expect('cadastrada', alice.msg())
        alice.fill('issue', amount='abc', method='ted', wallet=W_ALICE).expect('inválido', alice.msg())
        alice.fill('issue', amount='50.000,00', method='ted', wallet=W_ALICE).expect('registrado', alice.msg()).expect('Solicitada')

        # 5) emissora emite direto (coberto pela reserva)
        op.tab('ordens').expect('alice@cliente.test').expect('1 ordem(ns) esperando por você')
        op.click('[data-act="order-act"][data-key="emitir"]').expect('Emissão concluída', op.msg())
        assert chain_call('balanceOf(address) view returns (uint256)', W_ALICE) == str(50_000 * 10**6)
        alice.open('/app/brlzx').expect('50.000,00 BRLZX').expect('Emitida')

        # 6a) R$ 60 milhões passam do teto por emissão: a tela recusa antes de ir à rede, e a emissora rejeita a ordem
        alice.fill('issue', amount='60.000.000,00', method='pix', wallet=W_ALICE)
        op.tab('ordens').click('[data-act="order-act"][data-key="emitir"]').expect('teto por emissão', op.msg())
        op.click('[data-act="order-reject"]').expect('rejeitada', op.msg())
        # 6b) R$ 1 milhão com reserva de 800 mil: descoberto de 250 mil > limite => proposta + aprovação da proprietária
        alice.open('/app/brlzx').expect('Rejeitada').fill('issue', amount='1.000.000,00', method='pix', wallet=W_ALICE)
        own.tab('ordens').expect('Nenhuma ordem esperando por você'); assert own.page.locator('[data-key="emitir"]').count() == 0, 'proprietária não emite'
        op.tab('ordens').click('[data-act="order-act"][data-key="emitir"]').expect('proposta', op.msg())
        op.expect('Aguardando 2ª aprovação'); assert op.page.locator('[data-key="aprovar"]').count() == 0, 'emissora não aprova'
        assert chain_call('balanceOf(address) view returns (uint256)', W_ALICE) == str(50_000 * 10**6), 'proposta não emite'
        own.tab('ordens').expect('1 ordem(ns) esperando por você').click('[data-act="order-act"][data-key="aprovar"]').expect('aprovada', own.msg())
        assert chain_call('totalSupply() view returns (uint256)') == str(1_050_000 * 10**6)
        own.tab('cobertura').expect('250.000,00').expect('Faltam').expect('Rede e backoffice conferem')
        if shots: own.page.screenshot(path=shots + '/cobertura-proprietaria.png', full_page=True)

        # 7) resgate de R$ 20 mil: cliente envia, emissora confere, proprietária paga, emissora queima
        alice.open('/app/brlzx').fill('redeem', amount='20.000,00', wallet=W_ALICE, payout='Pix: alice@cliente.test').expect('registrado', alice.msg())
        alice.click('[data-act="send-tokens"]').expect('Tokens enviados', alice.msg())
        own.tab('ordens'); assert own.page.locator('[data-key="pagar"]').count() == 0, 'não paga antes de a emissora conferir'
        op.tab('ordens').expect('informado pelo cliente')
        op.dismiss_next = True                                    # hash falso: a tela confere na rede, avisa, e o operador desiste
        op.fill('receive', tx='0x' + 'ab' * 32)
        assert 'não encontrada na rede' in op.dialogs[-1], op.dialogs[-1]
        op.expect('informado pelo cliente')                        # ordem continua aguardando
        n = len(op.dialogs)
        op.fill('receive').expect('Recebimento confirmado', op.msg())   # hash real, já preenchido com o que o cliente informou
        assert len(op.dialogs) == n, 'hash verdadeiro não deve gerar aviso: %s' % op.dialogs[n:]
        own.tab('ordens').click('[data-act="order-act"][data-key="pagar"]').expect('Pagamento confirmado', own.msg())
        assert own.page.locator('[data-key="queimar"]').count() == 0, 'proprietária não queima'
        op.tab('ordens').click('[data-act="order-act"][data-key="queimar"]').expect('queimados', op.msg())
        assert chain_call('totalSupply() view returns (uint256)') == str(1_030_000 * 10**6)
        alice.open('/app/brlzx').expect('Concluída').expect('1.030.000,00 BRLZX')
        if shots: alice.page.screenshot(path=shots + '/cliente-mobile.png', full_page=True)

        # 8) compliance: emissora bloqueia um endereço; proprietária só acompanha
        op.tab('compliance').fill('compliance', address=W_OTHER, action='bloquear', reason='Ofício 123/2026').expect('Ação registrada', op.msg()).expect('Ofício 123/2026')
        assert chain_call('isBlocked(address) view returns (bool)', W_OTHER) == 'true'
        own.tab('compliance').expect('Ofício 123/2026'); assert own.page.locator('form[data-form="compliance"]').count() == 0

        # 9) auditoria e pausa
        own.tab('auditoria').expect('emissao.aprovar').expect('reserva.atestar').expect('resgate.pagar')
        op.tab('cobertura').click('[data-act="pause"]').expect('pausado', op.msg()); assert op.page.locator('[data-act="unpause"]').count() == 0
        own.tab('cobertura').expect('pausado').click('[data-act="unpause"]').expect('retomado', own.msg())
        if shots: op.tab('ordens'); op.page.locator('[data-filter="todas"]').click(); op.settle(); op.page.screenshot(path=shots + '/ordens-emissora.png', full_page=True)

        errs = [e for a in (admin, op, own, alice) for e in a.errors]
        assert not errs, 'erros de JavaScript: %s' % errs
        b.close()
    print('brlzx e2e: ok')


if __name__ == '__main__':
    main()
