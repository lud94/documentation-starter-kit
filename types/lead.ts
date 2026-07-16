export interface LeadPerson {
  first_name: string
  last_name: string
  full_name: string
  email: string
  personal_email?: string
  mobile_number?: string
  job_title: string
  headline?: string
  seniority_level?: string
  functional_level?: string
  linkedin?: string
  location?: {
    city: string
    state: string
    country: string
  }
}

export interface LeadCompany {
  name: string
  website?: string
  domain?: string
  phone?: string
  linkedin?: string
  industry?: string
  size?: number
  founded_year?: string
  description?: string
  keywords?: string
  address?: {
    street?: string
    city?: string
    state?: string
    postal_code?: string
    country?: string
    full_address?: string
  }
  financials?: {
    annual_revenue?: string
    annual_revenue_clean?: string
    total_funding?: string
    total_funding_clean?: string
  }
  technologies?: string[]
}

export interface Lead {
  person: LeadPerson
  company: LeadCompany
}

export type EmailStatus = 'idle' | 'sending' | 'sent' | 'error'

export interface SearchParams {
  industry: string
  location: string
  jobTitle: string
  employeeRange: string
  revenue: string
}
