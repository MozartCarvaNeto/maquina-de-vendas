// backend/src/services/qualificationEngine.js

/**
 * Formato esperado de campaign.qualificationRules (JSON salvo no banco):
 * {
 *   "logic": "ALL" | "ANY",
 *   "steps": [
 *     {
 *       "id": "renda_minima",
 *       "question": "Qual a sua renda mensal aproximada?",
 *       "type": "number_min",
 *       "minValue": 3000
 *     },
 *     {
 *       "id": "tem_entrada",
 *       "question": "Você possui valor de entrada disponível?",
 *       "type": "boolean_true"
 *     },
 *     {
 *       "id": "prazo_compra",
 *       "question": "Pretende comprar em quanto tempo?",
 *       "type": "one_of",
 *       "acceptedValues": ["ate_3_meses", "ate_6_meses"]
 *     }
 *   ]
 * }
 *
 * Formato esperado de "answers" (o que o lead respondeu):
 * {
 *   "renda_minima": 4500,
 *   "tem_entrada": true,
 *   "prazo_compra": "ate_3_meses"
 * }
 */

function evaluateStep(step, answers) {
  const answer = answers[step.id];

  if (answer === undefined || answer === null || answer === '') {
    return { stepId: step.id, passed: false, reason: 'Não respondido' };
  }

  switch (step.type) {
    case 'number_min': {
      const numericAnswer = Number(answer);
      const passed = !Number.isNaN(numericAnswer) && numericAnswer >= step.minValue;
      return {
        stepId: step.id,
        passed,
        reason: passed
          ? `Valor ${numericAnswer} atende ao mínimo de ${step.minValue}`
          : `Valor ${numericAnswer} abaixo do mínimo exigido (${step.minValue})`
      };
    }

    case 'number_max': {
      const numericAnswer = Number(answer);
      const passed = !Number.isNaN(numericAnswer) && numericAnswer <= step.maxValue;
      return {
        stepId: step.id,
        passed,
        reason: passed
          ? `Valor ${numericAnswer} dentro do limite de ${step.maxValue}`
          : `Valor ${numericAnswer} acima do limite permitido (${step.maxValue})`
      };
    }

    case 'boolean_true': {
      const passed = answer === true || answer === 'true' || answer === 'sim';
      return { stepId: step.id, passed, reason: passed ? 'Confirmado' : 'Não confirmado' };
    }

    case 'one_of': {
      const passed = Array.isArray(step.acceptedValues) && step.acceptedValues.includes(answer);
      return {
        stepId: step.id,
        passed,
        reason: passed ? `Resposta "${answer}" é aceita` : `Resposta "${answer}" não está na lista aceita`
      };
    }

    default:
      return { stepId: step.id, passed: false, reason: `Tipo de etapa desconhecido: ${step.type}` };
  }
}

/**
 * Avalia todas as respostas de um lead contra as regras da campanha.
 * @returns {{ qualified: boolean, details: Array<object> }}
 */
function evaluateAnswers(qualificationRules, answers) {
  if (!qualificationRules || !Array.isArray(qualificationRules.steps)) {
    // Sem regras configuradas -> por padrão, considera qualificado
    return { qualified: true, details: [] };
  }

  const logic = qualificationRules.logic === 'ANY' ? 'ANY' : 'ALL';
  const details = qualificationRules.steps.map((step) => evaluateStep(step, answers || {}));

  const qualified =
    logic === 'ALL' ? details.every((d) => d.passed) : details.some((d) => d.passed);

  return { qualified, details, logic };
}

module.exports = { evaluateAnswers };