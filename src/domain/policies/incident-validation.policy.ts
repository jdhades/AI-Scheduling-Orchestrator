import { MedicalCertificateData } from '../../infrastructure/services/llm-parsing.service';
import { Employee } from '../aggregates/employee.aggregate';
import { DomainError } from '../errors/domain.error';

export class IncidentValidationPolicy {
  /**
   * Validates if the parsed medical certificate belongs to the employee
   * and contains valid data.
   */
  static validateCertificateParams(
    parsedData: MedicalCertificateData,
    employeeName: string,
  ): boolean {
    if (
      !parsedData.patient_name ||
      !parsedData.issue_date ||
      !parsedData.rest_days
    ) {
      throw new DomainError(
        'Missing essential fields in the certificate (Name, Date, or Rest Days)',
      );
    }

    if (parsedData.rest_days < 1) {
      throw new DomainError('Rest days must be at least 1');
    }

    // Similarity matching of Name:
    // In a real scenario, could use Levenshtein distance.
    // Here we use simple lowercase inclusion check (e.g. "John Doe" vs "John M. Doe").
    const employeeTokens = employeeName.toLowerCase().split(' ');
    const patientNameLower = parsedData.patient_name.toLowerCase();

    // Requires at least the first name and last name to match partially
    const matchCount = employeeTokens.filter((token) =>
      patientNameLower.includes(token),
    ).length;

    // If less than half the name tokens match, flag as suspicious
    if (matchCount < employeeTokens.length / 2) {
      throw new DomainError(
        `Name mismatch: Certificate says '${parsedData.patient_name}', but employee is '${employeeName}'`,
      );
    }

    return true; // Validated
  }
}
