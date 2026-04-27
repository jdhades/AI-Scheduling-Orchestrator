import type { Employee } from '../../domain/aggregates/employee.aggregate';

export interface EmployeeDto {
  id: string;
  companyId: string;
  name: string;
  role: string;
  phone: string;
  externalId: string | null;
  experienceMonths: number;
  experienceLevel: 'junior' | 'intermediate' | 'senior';
  availability: { dayOfWeek: number; startTime: string; endTime: string }[];
  preferences: { preferenceType: string; weight: number }[];
  skills: { id: string; name: string; level: string }[];
}

export function toEmployeeDto(emp: Employee): EmployeeDto {
  return {
    id: emp.id,
    companyId: emp.companyId,
    name: emp.name,
    role: emp.role,
    phone: emp.phone,
    externalId: emp.externalId ?? null,
    experienceMonths: emp.experienceMonths,
    experienceLevel: emp.experienceLevel,
    availability: emp.getAvailability().map((a) => ({
      dayOfWeek: a.dayOfWeek,
      startTime: a.startTime,
      endTime: a.endTime,
    })),
    preferences: emp.getPreferences().map((p) => ({
      preferenceType: p.type,
      weight: p.weight,
    })),
    skills: emp.getSkills().map((s) => ({
      id: s.id,
      name: s.name,
      level: s.level,
    })),
  };
}
