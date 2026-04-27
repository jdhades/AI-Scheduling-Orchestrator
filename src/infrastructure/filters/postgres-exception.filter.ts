import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ConflictException,
  ExceptionFilter,
  HttpException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

/**
 * TODO(hardcode): mapeo constraint → errorCode estable.
 *   - qué se hardcodea: nombres de UNIQUE indexes específicos del schema.
 *   - por qué: las repos hoy envuelven el error de Supabase con
 *     `new Error(supabaseError.message)`, perdiendo el `code` (23505) y el
 *     `constraint` estructurado. Sin eso, parsear el mensaje es lo único
 *     posible, y necesitamos un id estable que el frontend pueda traducir.
 *   - cómo sacarlo después: cuando las repos preserven el error original
 *     (ej. `class RepositoryError extends Error { code; constraint; table; column }`),
 *     este filter pasa a un switch sobre (table, column, code) y el mapa por
 *     nombre desaparece.
 */
const CONSTRAINT_ERROR_CODES: Record<string, string> = {
  employees_phone_company_idx: 'EMPLOYEE_PHONE_DUPLICATE',
  employees_external_id_per_company: 'EMPLOYEE_EXTERNAL_ID_DUPLICATE',
  shift_memberships_unique_active_per_emp_tpl_from: 'MEMBERSHIP_DUPLICATE',
  company_skills_unique_active_per_company_skill: 'SKILL_DUPLICATE',
  company_policies_unique_active_per_interpreter: 'POLICY_INTERPRETER_DUPLICATE',
};

interface ErrorBody {
  errorCode: string;
  message: string;
  statusCode: number;
  field?: string;
  constraint?: string;
}

/**
 * Filter global que traduce errores no-HTTP (típicamente Postgres 23xxx
 * envueltos por las repos) a HttpException con un `errorCode` estable.
 *
 * Política: el backend NO mete texto traducido. Devuelve un id de error
 * (ej. `EMPLOYEE_PHONE_DUPLICATE`) más un `message` en inglés como
 * fallback. El frontend resuelve el id contra su catálogo i18n.
 *
 * Sin este filter, una violación de unique constraint sale como
 * "Internal Server Error 500" y el manager no sabe qué pasó.
 */
@Catch(Error)
export class PostgresExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PostgresExceptionFilter.name);

  catch(exception: Error, host: ArgumentsHost) {
    if (exception instanceof HttpException) {
      // Excepciones ya formadas (ValidationPipe, throws explícitos): pasan.
      return this.respondHttp(host, exception);
    }

    const mapped = this.mapPostgresError(exception);
    if (mapped) {
      this.logger.warn(
        `[postgres] ${exception.message} → ${mapped.statusCode} ${mapped.errorCode}`,
      );
      return this.respondBody(host, mapped);
    }

    this.logger.error(
      `Unhandled exception: ${exception.message}`,
      exception.stack,
    );
    return this.respondBody(host, {
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred. Please contact support if it persists.',
    });
  }

  private respondHttp(host: ArgumentsHost, ex: HttpException) {
    const res = host.switchToHttp().getResponse<Response>();
    const status = ex.getStatus();
    const body = ex.getResponse();
    res
      .status(status)
      .json(
        typeof body === 'string' ? { message: body, statusCode: status } : body,
      );
  }

  private respondBody(host: ArgumentsHost, body: ErrorBody) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(body.statusCode)
      .json(body);
  }

  private mapPostgresError(err: Error): ErrorBody | null {
    const msg = err.message ?? '';

    // 23505 — unique_violation
    const unique = msg.match(
      /duplicate key value violates unique constraint "([^"]+)"/,
    );
    if (unique) {
      const constraint = unique[1];
      const errorCode =
        CONSTRAINT_ERROR_CODES[constraint] ?? 'UNIQUE_VIOLATION';
      return {
        statusCode: new ConflictException().getStatus(),
        errorCode,
        message: 'A record with these values already exists.',
        constraint,
      };
    }

    // 23502 — not_null_violation
    const notNull = msg.match(/null value in column "([^"]+)"/);
    if (notNull) {
      return {
        statusCode: new BadRequestException().getStatus(),
        errorCode: 'NOT_NULL_VIOLATION',
        message: `Field "${notNull[1]}" is required and cannot be empty.`,
        field: notNull[1],
      };
    }

    // 23503 — foreign_key_violation
    if (/violates foreign key constraint/.test(msg)) {
      return {
        statusCode: new BadRequestException().getStatus(),
        errorCode: 'FOREIGN_KEY_VIOLATION',
        message:
          'The operation references a record that does not exist or has been deleted.',
      };
    }

    // 23514 — check_violation
    if (/violates check constraint/.test(msg)) {
      return {
        statusCode: new BadRequestException().getStatus(),
        errorCode: 'CHECK_VIOLATION',
        message: 'The submitted data does not meet a validation rule.',
      };
    }

    return null;
  }
}
