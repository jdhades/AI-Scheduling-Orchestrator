/**
 * Script one-off: re-extrae la estructura de TODAS las reglas activas que no
 * tengan structure en la BD. Útil tras la migration que introduce la columna.
 *
 * Uso: npx ts-node scripts/re-extract-rule-structures.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { Logger } from '@nestjs/common';
import { RuleStructureExtractor } from '../src/domain/services/rule-structure-extractor.service';
import {
  SEMANTIC_RULE_REPOSITORY_TOKEN,
  type ISemanticRuleRepository,
} from '../src/domain/repositories/semantic-rule.repository.interface';
import { createClient } from '@supabase/supabase-js';

async function main() {
  const logger = new Logger('re-extract-rule-structures');
  const app = await NestFactory.createApplicationContext(AppModule);

  const extractor = app.get(RuleStructureExtractor);
  const ruleRepo = app.get<ISemanticRuleRepository>(
    SEMANTIC_RULE_REPOSITORY_TOKEN,
  );

  // Query directa a Supabase para listar companies y sus reglas sin structure
  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data: companies } = await supabase
    .from('companies')
    .select('id, name');

  let total = 0;
  let extracted = 0;
  let failed = 0;

  // Por defecto re-extrae TODAS las reglas. Pasar --pending-only para solo las sin structure.
  const pendingOnly = process.argv.includes('--pending-only');

  for (const company of companies ?? []) {
    const rules = await ruleRepo.findAllByCompany(company.id as string);
    const toProcess = pendingOnly ? rules.filter((r) => !r.hasStructure()) : rules;
    logger.log(
      `Company "${company.name}" (${company.id}): ${rules.length} active rules, processing ${toProcess.length} ${pendingOnly ? '(pending only)' : '(all — force re-extract)'}`,
    );

    for (const rule of toProcess) {
      total++;
      const structure = await extractor.extract({
        ruleText: rule.getRuleText(),
        companyId: company.id as string,
      });
      if (structure) {
        rule.setStructure(structure);
        await ruleRepo.save(rule);
        extracted++;
        logger.log(
          `  ✓ "${rule.getRuleText().substring(0, 60)}" → intent=${structure.intent}`,
        );
      } else {
        failed++;
        logger.warn(
          `  ✗ "${rule.getRuleText().substring(0, 60)}" — LLM failed to extract`,
        );
      }
    }
  }

  logger.log(
    `Done — total=${total} extracted=${extracted} failed=${failed}`,
  );
  await app.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
