const am = require('../src/services/answeringMachineService');
const M = [
 'O número que você ligou não está disponível. Deixe sua mensagem após o sinal.',
 'Você ligou para a caixa postal de 11 9 8 7 6 5. Por favor deixe seu recado após o bipe',
 'Olá, a pessoa que você está tentando ligar usa um recurso de filtragem de chamadas. Diga seu nome e o motivo da ligação.',
 'Se você disser seu nome e o motivo da ligação, vou ver se esta pessoa está disponível',
 'O telefone chamado está desligado ou fora da área de cobertura',
 'Vivo informa: o número chamado não existe. Verifique o número discado.',
 'Para deixar uma mensagem, aguarde o sinal. Quando terminar, desligue ou tecle 1 para mais opções.',
 'Bem-vindo à central de atendimento. Digite 1 para vendas, 2 para financeiro.',
 'Olá, a pessoa que você está ligando está usando um serviço de triagem de chamadas do Google e receberá uma cópia desta conversa.',
 'Este número não recebe chamadas a cobrar',
 'Estamos fora do horário de atendimento. Nosso horário de atendimento é de segunda a sexta das 8 às 18. Deixe seu recado.',
 'Não pode atender no momento, grave sua mensagem',
 'Pressione a tecla jogo da velha para finalizar a gravação',
 'Obrigado por ligar. Todos os nossos atendentes estão ocupados, aguarde na linha, sua ligação é muito importante para nós',
 'Hi the person you are trying to reach is not available, leave a message after the tone',
 'Esta chamada pode ser gravada para fins de qualidade. Digite o seu CPF',
];
const H = ['Alô?','Alô, quem fala?','Oi, pode falar','Sim, é ele mesmo','Não posso atender agora, me liga mais tarde','Estou dirigindo, ligue depois','Quem é? De onde fala?','Não tenho interesse, obrigado','Pois não','Boa tarde, com quem eu falo?','Número errado','Hã? Não entendi','Fala aí','Sou eu sim, do que se trata?','Estou ocupado agora','A pessoa que você procura não mora aqui','Aqui é o João, pode falar'];
let bad=0;
for (const t of M){const r=am.classifyConversation([t]); if(!r.isMachine){bad++;console.log('MISS',t)}}
for (const t of H){const r=am.classifyConversation([t]); if(r.isMachine){bad++;console.log('FALSE+',t,r.reason)}}
// fragmentos
let r=am.classifyConversation(['Você ligou para','deixe sua mensagem']); if(!r.isMachine){bad++;console.log('frag miss')}
r=am.classifyConversation(['esse numero nao tem ninguem com esse nome aqui na casa ok','esse numero nao tem ninguem com esse nome aqui na casa ok']); console.log('loop',r.isMachine);
console.log(am.classifyUtterance('O número chamado não existe').outcome, am.isMachineAnsweredBy('machine_end_beep'), am.isMachineAnsweredBy('human'));
console.log(bad?'FALHAS '+bad:'OK');
