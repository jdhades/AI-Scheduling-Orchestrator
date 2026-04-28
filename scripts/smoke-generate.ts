/**
 * smoke-generate.ts — smoke test del pipeline completo de generación.
 *
 * Arranca el AppModule, despacha GenerateHybridScheduleCommand contra el
 * seed de scripts/seed-fresh.js (compañía 11111111-...) y loguea las
 * asignaciones resultantes por template + día para verificar que el
 * comportamiento round-robin + memberships funciona.
 *
 * Bypass del guard de auth: usamos el CommandBus directamente, no pasa por
 * SupabaseAuthGuard.
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/smoke-generate.ts [weekStart]
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { CommandBus } from '@nestjs/cqrs';
import { AppModule } from '../src/app.module';
import { GenerateHybridScheduleCommand } from '../src/application/commands/generate-hybrid-schedule.command';
import { createClient } from '@supabase/supabase-js';

const COMPANY_ID = '11111111-2222-3333-4444-555555555555';

function defaultWeekStart(): string {
  const d = new Date();
  const dow = d.getUTCDay();
  const daysUntilMonday = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().split('T')[0];
}

async function main() {
  const weekStart = process.argv[2] ?? defaultWeekStart();
  console.log(`\n🧪 Smoke: generating schedule for week ${weekStart}, company ${COMPANY_ID}\n`);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  const commandBus = app.get(CommandBus);

  const result: any = await commandBus.execute(
    new GenerateHybridScheduleCommand(COMPANY_ID, weekStart, undefined, undefined, 'es'),
  );

  console.log('\n📊 Result summary:');
  console.log(`  total assignments   : ${result.assignmentsCount}`);
  console.log(`  unfilled slots      : ${result.unfilledShiftsCount}`);
  console.log(`  LLM accepted        : ${result.llmAccepted}`);
  console.log(`  algorithm corrected : ${result.algorithmCorrected}`);
  if (result.warnings?.length) {
    console.log('\n⚠️  Warnings:');
    for (const w of result.warnings) console.log(`  - ${w}`);
  }

  // Leer las assignments recién persistidas para un resumen por template × día
  const supabase = createClient(
    process.env.SUPABASE_URL ?? 'http://localhost:54321',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? 'REDACTED_SUPABASE_SECRET',
  );
  const weekEnd = new Date(`${weekStart}T00:00:00Z`);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekEndStr = weekEnd.toISOString().split('T')[0];

  const { data, error } = await supabase
    .from('shift_assignments')
    .select('template_id, date, employee_id, origin')
    .eq('company_id', COMPANY_ID)
    .gte('date', weekStart)
    .lte('date', weekEndStr)
    .order('date', { ascending: true });
  if (error) throw error;

  const { data: templates } = await supabase
    .from('shift_templates')
    .select('id, name, required_employees')
    .eq('company_id', COMPANY_ID);
  const tplName = new Map((templates ?? []).map((t) => [t.id, t.name]));
  const tplReq = new Map((templates ?? []).map((t) => [t.id, t.required_employees]));

  const { data: emps } = await supabase
    .from('employees')
    .select('id, name')
    .eq('company_id', COMPANY_ID);
  const empName = new Map((emps ?? []).map((e) => [e.id, e.name]));

  console.log('\n📅 Assignments per (template, day):');
  type Bucket = { employees: string[]; origins: Set<string> };
  const byTemplateByDate = new Map<string, Map<string, Bucket>>();
  for (const a of data ?? []) {
    if (!byTemplateByDate.has(a.template_id)) byTemplateByDate.set(a.template_id, new Map());
    const byDate = byTemplateByDate.get(a.template_id)!;
    if (!byDate.has(a.date)) byDate.set(a.date, { employees: [], origins: new Set() });
    const b = byDate.get(a.date)!;
    b.employees.push(empName.get(a.employee_id) ?? a.employee_id.slice(0, 6));
    b.origins.add(a.origin);
  }

  for (const [templateId, byDate] of byTemplateByDate) {
    const name = tplName.get(templateId) ?? templateId.slice(0, 8);
    const req = tplReq.get(templateId);
    console.log(`\n  ${name}  (required_employees=${req ?? 'null (elástico)'})`);
    const days = [...byDate.keys()].sort();
    for (const date of days) {
      const b = byDate.get(date)!;
      const origins = [...b.origins].join(',');
      console.log(`    ${date}  [${origins}]  ${b.employees.join(', ')}`);
    }
  }

  await app.close();
}

main().catch((err) => {
  console.error('❌ Smoke failed:', err);
  process.exit(1);
});
