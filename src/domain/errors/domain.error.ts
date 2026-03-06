/**
 * DomainError
 *
 * Base error class for all domain rule violations.
 * Use this to signal business rule failures (not infrastructure errors).
 */
export class DomainError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DomainError';
    }
}
