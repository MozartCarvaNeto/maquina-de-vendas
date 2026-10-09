// backend/scripts/createAdmin.js
//
// Cria (ou atualiza a senha de) o ADMINISTRADOR DA PLATAFORMA.
// Uso, dentro da pasta backend:
//     npm run admin:create
// O script pergunta nome, e-mail e senha. Depois, coloque o MESMO e-mail na
// linha SUPERADMIN_EMAILS= do arquivo .env e reinicie o servidor.
require('dotenv').config();
const readline = require('readline');
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/db');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (question) => new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));

async function main() {
  console.log('\n=== Criar administrador da plataforma ===\n');
  const name = (await ask('Seu nome: ')) || 'Administrador';
  const email = (await ask('Seu e-mail (será o login): ')).toLowerCase();
  const password = await ask('Senha (mínimo 8 caracteres): ');

  if (!email || !email.includes('@')) throw new Error('E-mail inválido.');
  if (password.length < 8) throw new Error('A senha precisa ter pelo menos 8 caracteres.');

  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await prisma.member.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });

  if (existing) {
    await prisma.member.update({ where: { id: existing.id }, data: { passwordHash, status: 'ativo' } });
    await prisma.account.update({
      where: { id: existing.accountId },
      data: { accessStatus: 'ativa', subscriptionEndsAt: null, blockedReason: null }
    });
    console.log(`\n✅ Usuário já existia: a senha de ${existing.email} foi atualizada e a conta liberada.`);
  } else {
    const account = await prisma.account.create({
      data: {
        name: 'Administração',
        accessStatus: 'ativa',
        plan: 'Administrador',
        subscriptionStartsAt: new Date(),
        members: { create: { name, email, passwordHash, role: 'owner', status: 'ativo' } }
      }
    });
    await prisma.crmBoard.create({
      data: {
        userId: account.id,
        name: 'Funil Principal',
        columns: {
          create: [
            { name: 'Novos', position: 0, color: '#00b4d8' },
            { name: 'Em Qualificação', position: 1, color: '#48cae4' },
            { name: 'Qualificado', position: 2, color: '#0096c7' },
            { name: 'Em Negociação', position: 3, color: '#0077b6' },
            { name: 'Fechado', position: 4, color: '#22c55e' },
            { name: 'Perdido', position: 5, color: '#ef4444' }
          ]
        }
      }
    });
    console.log(`\n✅ Administrador criado: ${email}`);
  }

  console.log('\nPRÓXIMO PASSO (obrigatório): abra o arquivo backend/.env e deixe esta linha:');
  console.log(`\n   SUPERADMIN_EMAILS=${email}\n`);
  console.log('Depois reinicie o servidor. O menu "🛡️ Administração" aparecerá para você.\n');
}

main()
  .catch((err) => {
    console.error('\n❌ Erro:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    rl.close();
    await prisma.$disconnect();
  });
