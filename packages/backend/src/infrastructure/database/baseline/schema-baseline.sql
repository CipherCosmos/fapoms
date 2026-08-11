--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4 (Debian 16.4-1.pgdg110+2)
-- Dumped by pg_dump version 16.4 (Debian 16.4-1.pgdg110+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: tiger; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA tiger;


--
-- Name: tiger_data; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA tiger_data;


--
-- Name: topology; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA topology;


--
-- Name: SCHEMA topology; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA topology IS 'PostGIS Topology schema';


--
-- Name: fuzzystrmatch; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;


--
-- Name: EXTENSION fuzzystrmatch; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION fuzzystrmatch IS 'determine similarities and distance between strings';


--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


--
-- Name: postgis_tiger_geocoder; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis_tiger_geocoder WITH SCHEMA tiger;


--
-- Name: EXTENSION postgis_tiger_geocoder; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis_tiger_geocoder IS 'PostGIS tiger geocoder and reverse geocoder';


--
-- Name: postgis_topology; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis_topology WITH SCHEMA topology;


--
-- Name: EXTENSION postgis_topology; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis_topology IS 'PostGIS topology spatial types and functions';


--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


--
-- Name: EXTENSION "uuid-ossp"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION "uuid-ossp" IS 'generate universally unique identifiers (UUIDs)';


--
-- Name: assayers_lifecycle_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.assayers_lifecycle_status_enum AS ENUM (
    'INVITED',
    'DOCUMENT_VERIFICATION',
    'BACKGROUND_VERIFICATION',
    'TRAINING',
    'ACTIVE',
    'ON_LEAVE',
    'SUSPENDED',
    'INACTIVE',
    'RESIGNED',
    'TERMINATED',
    'ARCHIVED'
);


--
-- Name: assayers_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.assayers_status_enum AS ENUM (
    'ACTIVE',
    'INACTIVE',
    'SUSPENDED'
);


--
-- Name: assessments_priority_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.assessments_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: assessments_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.assessments_status_enum AS ENUM (
    'PENDING_PLANNING',
    'ASSESSOR_RECOMMENDED',
    'IN_NEGOTIATION',
    'ASSIGNED_AND_SCHEDULED',
    'UNASSIGNED',
    'AWAITING_CLIENT_DATA',
    'CLIENT_DATA_RECEIVED',
    'PDF_GENERATED',
    'READY_FOR_DISPATCH',
    'DISPATCHED_TO_ASSESSOR',
    'AUDITED_PDF_RECEIVED',
    'SENT_TO_DATA_ENTRY',
    'DATA_ENTRY_IN_PROGRESS',
    'CLARIFICATION_NEEDED',
    'REPORT_FINALIZED',
    'PENDING_HEAD_APPROVAL',
    'DELIVERED_TO_CLIENT',
    'COMPLETED'
);


--
-- Name: assignments_priority_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.assignments_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: assignments_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.assignments_status_enum AS ENUM (
    'PENDING',
    'ACCEPTED',
    'CHECKED_IN',
    'IN_PROGRESS',
    'COMPLETED',
    'REJECTED',
    'CANCELLED'
);


--
-- Name: communications_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.communications_type_enum AS ENUM (
    'PHONE',
    'WHATSAPP',
    'EMAIL',
    'SYSTEM'
);


--
-- Name: coverage_plans_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.coverage_plans_status_enum AS ENUM (
    'DRAFT',
    'GENERATED',
    'UNDER_REVIEW',
    'APPROVED',
    'LOCKED',
    'DEPLOYED',
    'ARCHIVED'
);


--
-- Name: customer_master_versions_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.customer_master_versions_status_enum AS ENUM (
    'DRAFT',
    'RECONCILED',
    'APPROVED',
    'SUPERSEDED',
    'REJECTED'
);


--
-- Name: documents_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.documents_status_enum AS ENUM (
    'UPLOADED',
    'DISPATCHED',
    'RECEIVED',
    'SENT_TO_DATA_ENTRY',
    'SENT_TO_EXTERNAL_OCR',
    'EXCEL_GENERATED',
    'PROCESSED',
    'COMPLETED',
    'ARCHIVED'
);


--
-- Name: documents_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.documents_type_enum AS ENUM (
    'BRANCH_LIST',
    'CUSTOMER_MASTER_DATA',
    'PRE_FIELD_AUDIT_PDF',
    'AUDITED_RETURN_PDF',
    'GENERATED_EXCEL',
    'FINAL_REPORT'
);


--
-- Name: ocr_jobs_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ocr_jobs_status_enum AS ENUM (
    'PENDING',
    'PROCESSING',
    'COMPLETED',
    'FAILED',
    'DEAD_LETTER'
);


--
-- Name: operations_exceptions_category_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_exceptions_category_enum AS ENUM (
    'UNCOVERABLE_BRANCH',
    'CAPACITY_EXCEEDED',
    'SCHEDULE_CONFLICT',
    'COMMERCIAL_DISCREPANCY',
    'CERTIFICATION_EXPIRED',
    'ROUTE_UNREACHABLE'
);


--
-- Name: operations_exceptions_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_exceptions_status_enum AS ENUM (
    'UNRESOLVED',
    'RESOLVED',
    'BYPASSED'
);


--
-- Name: operations_execution_conversations_sender_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_execution_conversations_sender_enum AS ENUM (
    'OPERATIONS',
    'ASSAYER',
    'SYSTEM'
);


--
-- Name: operations_execution_groups_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_execution_groups_status_enum AS ENUM (
    'DRAFT',
    'DISPATCHED',
    'ACCEPTED',
    'DECLINED',
    'CONFIRMED',
    'READY',
    'COMPLETED',
    'CANCELLED'
);


--
-- Name: operations_field_incidents_severity_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_field_incidents_severity_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: operations_field_incidents_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_field_incidents_status_enum AS ENUM (
    'REPORTED',
    'INVESTIGATING',
    'RESOLVED',
    'ESCALATED'
);


--
-- Name: operations_field_visits_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_field_visits_status_enum AS ENUM (
    'READY',
    'DISPATCHED',
    'TRAVELLING',
    'ARRIVED',
    'AUDIT_STARTED',
    'EVIDENCE_COLLECTION',
    'AUDIT_COMPLETED',
    'DELIVERABLE_PREPARATION',
    'SUBMITTED',
    'HANDOVER_READY'
);


--
-- Name: operations_tasks_priority_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_tasks_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: operations_tasks_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operations_tasks_status_enum AS ENUM (
    'OPEN',
    'IN_PROGRESS',
    'RESOLVED',
    'DISMISSED'
);


--
-- Name: project_branches_priority_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.project_branches_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: project_branches_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.project_branches_status_enum AS ENUM (
    'IMPORTED',
    'PLANNING',
    'CANDIDATE_SEARCH',
    'CONTACT_INITIATED',
    'NEGOTIATION',
    'ASSIGNMENT_CONFIRMED',
    'SCHEDULED',
    'AUDIT_COMPLETED',
    'VALIDATION_COMPLETED',
    'CLOSED',
    'UNABLE_TO_COVER',
    'ON_HOLD',
    'CANCELLED'
);


--
-- Name: projects_priority_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.projects_priority_enum AS ENUM (
    'LOW',
    'MEDIUM',
    'HIGH',
    'CRITICAL'
);


--
-- Name: projects_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.projects_status_enum AS ENUM (
    'DRAFT',
    'PLANNING',
    'SCHEDULING',
    'EXECUTION',
    'VALIDATION',
    'COMPLETED',
    'ARCHIVED',
    'CANCELLED',
    'ON_HOLD'
);


--
-- Name: schedules_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.schedules_status_enum AS ENUM (
    'TENTATIVE',
    'CONFIRMED',
    'RESCHEDULED',
    'COMPLETED'
);


--
-- Name: validation_cases_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.validation_cases_status_enum AS ENUM (
    'PENDING',
    'ASSIGNED',
    'OCR_PROCESSING',
    'HUMAN_REVIEW',
    'CORRECTION_REQUIRED',
    'APPROVED',
    'SUBMITTED'
);


--
-- Name: validation_queries_status_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.validation_queries_status_enum AS ENUM (
    'OPEN',
    'RESPONDED',
    'RESOLVED'
);


--
-- Name: validation_query_messages_author_type_enum; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.validation_query_messages_author_type_enum AS ENUM (
    'STAFF',
    'ASSAYER'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: assayer_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_activities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    event_type character varying(100) NOT NULL,
    previous_state character varying(50),
    new_state character varying(50),
    performed_by uuid NOT NULL,
    performed_by_name character varying(200),
    remarks text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: assayer_audit_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_audit_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "auditId" character varying NOT NULL,
    "assayerId" character varying NOT NULL,
    "clientId" character varying NOT NULL,
    "projectId" character varying NOT NULL,
    status character varying NOT NULL,
    outcome character varying NOT NULL,
    "startTime" timestamp without time zone,
    "endTime" timestamp without time zone,
    "slaStatus" character varying,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: assayer_commercial_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_commercial_profiles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    base_fee numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    hourly_rate numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    daily_rate numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    travel_reimbursement numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    accommodation_allowance numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    meal_allowance numeric(12,2) DEFAULT '0'::numeric NOT NULL,
    currency character varying(10) DEFAULT 'INR'::character varying NOT NULL,
    effective_start_date timestamp with time zone NOT NULL,
    effective_end_date timestamp with time zone
);


--
-- Name: assayer_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    document_type character varying(50) NOT NULL,
    file_name character varying(255) NOT NULL,
    file_path text NOT NULL,
    file_size integer NOT NULL,
    mime_type character varying(100),
    doc_version integer DEFAULT 1 NOT NULL,
    parent_document_id uuid,
    remarks text
);


--
-- Name: assayer_government_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_government_documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    document_type character varying(50) NOT NULL,
    expiry_date date,
    verification_status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    verified_at timestamp with time zone,
    verified_by uuid,
    file_paths jsonb DEFAULT '[]'::jsonb NOT NULL,
    remarks text,
    document_number text NOT NULL
);


--
-- Name: assayer_payables; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_payables (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    payable_number character varying(50) NOT NULL,
    assayer_id uuid NOT NULL,
    client_id uuid,
    project_id uuid,
    assignment_id uuid,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    base_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    travel_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    tds_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    total_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    paid_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    rate_snapshot jsonb,
    approved_at timestamp with time zone,
    approved_by uuid,
    paid_at timestamp with time zone,
    paid_by uuid,
    remarks text
);


--
-- Name: assayer_remarks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayer_remarks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    author_id uuid NOT NULL,
    author_name character varying(200) NOT NULL,
    content text NOT NULL,
    category character varying(50) DEFAULT 'GENERAL'::character varying NOT NULL,
    visibility character varying(50) DEFAULT 'PUBLIC'::character varying NOT NULL,
    attachment_paths jsonb DEFAULT '[]'::jsonb NOT NULL,
    rating numeric(3,2)
);


--
-- Name: assayers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assayers (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_code character varying(50) NOT NULL,
    employee_id character varying(50),
    password_hash character varying(255),
    employee_code character varying(50),
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    display_name character varying(200) NOT NULL,
    email character varying(255),
    phone character varying(20) NOT NULL,
    alternate_phone character varying(20),
    address text NOT NULL,
    state character varying(100) NOT NULL,
    district character varying(100) NOT NULL,
    city character varying(100) NOT NULL,
    pincode character varying(20),
    latitude numeric(10,7),
    longitude numeric(10,7),
    location public.geometry(Point,4326),
    organization_id uuid,
    ifsc_code character varying(20),
    notes text,
    employment_type character varying(50) DEFAULT 'INTERNAL'::character varying NOT NULL,
    joining_date date,
    exit_date date,
    termination_date date,
    manager_id uuid,
    department character varying(100),
    region character varying(100),
    emergency_contact_name character varying(200),
    emergency_contact_phone character varying(20),
    emergency_contact_relation character varying(100),
    photograph character varying(500),
    preferred_regions jsonb,
    experience_years integer DEFAULT 0 NOT NULL,
    performance_rating numeric(3,2) DEFAULT '5'::numeric NOT NULL,
    leaves jsonb,
    working_hours jsonb,
    max_daily_workload integer DEFAULT 3 NOT NULL,
    max_weekly_workload integer DEFAULT 15 NOT NULL,
    eligible_clients jsonb,
    total_assignments integer DEFAULT 0 NOT NULL,
    completed_assignments integer DEFAULT 0 NOT NULL,
    cancelled_assignments integer DEFAULT 0 NOT NULL,
    on_time_completions integer DEFAULT 0 NOT NULL,
    total_earnings numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    last_assignment_date timestamp with time zone,
    average_rating numeric(3,2) DEFAULT '0'::numeric NOT NULL,
    status public.assayers_status_enum DEFAULT 'ACTIVE'::public.assayers_status_enum NOT NULL,
    lifecycle_status public.assayers_lifecycle_status_enum DEFAULT 'INVITED'::public.assayers_lifecycle_status_enum NOT NULL,
    is_live_enabled boolean DEFAULT false NOT NULL,
    live_latitude numeric(10,7),
    live_longitude numeric(10,7),
    live_location public.geometry(Point,4326),
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    must_change_password boolean DEFAULT false NOT NULL,
    pan_number text,
    bank_account_number text,
    preferred_contact_channel character varying(10) DEFAULT 'AUTO'::character varying NOT NULL
);


--
-- Name: assessments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assessments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    status public.assessments_status_enum DEFAULT 'PENDING_PLANNING'::public.assessments_status_enum NOT NULL,
    packet_size integer,
    assigned_assessor_id uuid,
    audit_date date,
    agreed_fee numeric(12,2),
    coverage_flag boolean DEFAULT false NOT NULL,
    priority public.assessments_priority_enum DEFAULT 'MEDIUM'::public.assessments_priority_enum NOT NULL,
    zone_id uuid,
    remarks text
);


--
-- Name: assignment_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment_comments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assignment_id uuid NOT NULL,
    user_id uuid NOT NULL,
    user_name character varying(255) NOT NULL,
    comment text NOT NULL
);


--
-- Name: assignment_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignment_expenses (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assignment_id uuid NOT NULL,
    assayer_id uuid NOT NULL,
    category character varying(20) NOT NULL,
    amount numeric(12,2) NOT NULL,
    description text,
    receipt_url text,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    review_notes text
);


--
-- Name: assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.assignments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assignment_number character varying(50) NOT NULL,
    project_branch_id uuid,
    assessment_id uuid,
    project_id uuid NOT NULL,
    assayer_id uuid NOT NULL,
    status public.assignments_status_enum DEFAULT 'PENDING'::public.assignments_status_enum NOT NULL,
    priority public.assignments_priority_enum DEFAULT 'MEDIUM'::public.assignments_priority_enum NOT NULL,
    proposed_fee numeric(12,2),
    agreed_fee numeric(12,2),
    scheduled_date date,
    completion_date date,
    remarks text,
    sync_token character varying(100),
    entity_version integer DEFAULT 1 NOT NULL,
    sla_due_date timestamp with time zone,
    sla_status character varying(50) DEFAULT 'COMPLIANT'::character varying NOT NULL,
    cancel_reason text,
    reject_reason text,
    execution_group_id uuid,
    negotiation_count integer DEFAULT 0 NOT NULL,
    auto_schedule boolean DEFAULT true NOT NULL,
    check_in_latitude numeric(10,7),
    check_in_longitude numeric(10,7),
    check_in_accuracy_meters integer,
    check_in_distance_meters integer,
    checked_in_at timestamp with time zone
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    category character varying(50) NOT NULL,
    event_type character varying(100) NOT NULL,
    entity_type character varying(100) NOT NULL,
    entity_id uuid NOT NULL,
    previous_state character varying(50),
    new_state character varying(50),
    user_id uuid,
    user_display_name character varying(200),
    ip_address character varying(50),
    remarks text,
    metadata jsonb,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: COLUMN audit_events.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_events.category IS 'Event category: OPERATIONAL, USER, WORKFLOW, SYSTEM';


--
-- Name: COLUMN audit_events.event_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_events.event_type IS 'Specific event type, e.g. ASSIGNMENT_ACCEPTED, PROJECT_CREATED';


--
-- Name: COLUMN audit_events.entity_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_events.entity_type IS 'Type of entity this event relates to, e.g. PROJECT, ASSIGNMENT';


--
-- Name: COLUMN audit_events.entity_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_events.entity_id IS 'ID of the entity this event relates to';


--
-- Name: COLUMN audit_events.user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_events.user_id IS 'User who triggered the event (null for system events)';


--
-- Name: COLUMN audit_events.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.audit_events.metadata IS 'Additional structured data about the event';


--
-- Name: audit_evidence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_evidence (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "auditId" character varying NOT NULL,
    "fileType" character varying NOT NULL,
    "filePath" character varying NOT NULL,
    "gpsCoordinates" jsonb,
    "ocrResult" jsonb,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audits (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "assignmentId" character varying NOT NULL,
    "assayerId" character varying NOT NULL,
    "projectId" character varying NOT NULL,
    "branchId" character varying NOT NULL,
    status character varying NOT NULL,
    "scheduledDate" timestamp without time zone,
    "completionDate" timestamp without time zone,
    "slaStatus" character varying,
    "createdAt" timestamp without time zone DEFAULT now() NOT NULL,
    "updatedAt" timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: billing_conflicts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_conflicts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    conflict_number character varying(50) NOT NULL,
    severity character varying(20) DEFAULT 'WARNING'::character varying NOT NULL,
    entity_type character varying(20) NOT NULL,
    entry_ids jsonb NOT NULL,
    description text NOT NULL,
    reason text,
    created_by_id uuid NOT NULL,
    status character varying(20) DEFAULT 'OPEN'::character varying NOT NULL,
    resolution_action character varying(20),
    resolution_note text,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    blocks_billing boolean DEFAULT false NOT NULL
);


--
-- Name: billing_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_entries (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    entry_number character varying(50) NOT NULL,
    level character varying(20) NOT NULL,
    client_id uuid NOT NULL,
    project_id uuid,
    assignment_id uuid,
    assayer_id uuid,
    state character varying(30) NOT NULL,
    payment_state character varying(20) NOT NULL,
    pricing_model character varying(30) DEFAULT 'FLAT_RATE'::character varying NOT NULL,
    rate numeric(14,2),
    quantity numeric(14,2),
    billing_period_start date,
    billing_period_end date,
    description text,
    base_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    travel_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    adjustment_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    discount_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    tax_rate numeric(6,2) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    tds_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    total_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    billed_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    paid_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    outstanding_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    disputed_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    cancelled_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    adjusted_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    parent_entry_id uuid,
    source_entry_id uuid,
    invoice_id uuid,
    tds_rate numeric(6,2) DEFAULT '0'::numeric NOT NULL,
    taxable_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL
);


--
-- Name: billing_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_id uuid,
    project_id uuid,
    assignment_id uuid,
    assayer_id uuid,
    entity_type character varying(20) NOT NULL,
    entity_id uuid NOT NULL,
    action character varying(100) NOT NULL,
    from_state character varying(30),
    to_state character varying(30),
    previous_value jsonb,
    new_value jsonb,
    reason text,
    user_name character varying(255)
);


--
-- Name: billing_invoices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_invoices (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    invoice_number character varying(50) NOT NULL,
    client_id uuid NOT NULL,
    project_id uuid,
    type character varying(20) DEFAULT 'PER_PROJECT'::character varying NOT NULL,
    status character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    issue_date date,
    due_date date,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    subtotal numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    discount_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    tax_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    total numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    paid_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    outstanding_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL,
    notes text,
    tds_amount numeric(14,2) DEFAULT '0'::numeric NOT NULL
);


--
-- Name: billing_payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.billing_payments (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    invoice_id uuid,
    payment_reference character varying(100) NOT NULL,
    method character varying(20) NOT NULL,
    amount numeric(14,2) NOT NULL,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    received_date date,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    allocated_to_entry_ids jsonb,
    notes text,
    direction character varying(10) DEFAULT 'INBOUND'::character varying NOT NULL,
    payable_id uuid,
    assayer_id uuid,
    running_balance numeric(14,2)
);


--
-- Name: branch_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branch_contacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    branch_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    email character varying(255) NOT NULL,
    phone character varying(20) NOT NULL,
    designation character varying(200) NOT NULL,
    department character varying(200),
    is_primary boolean DEFAULT false NOT NULL,
    notes text
);


--
-- Name: branch_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branch_documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    branch_id uuid NOT NULL,
    file_name character varying(255) NOT NULL,
    file_path text NOT NULL,
    file_size integer NOT NULL,
    mime_type character varying(100),
    category character varying(50) NOT NULL,
    remarks text
);


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    branch_code character varying(50) NOT NULL,
    sol_id character varying(50),
    name character varying(255) NOT NULL,
    address text NOT NULL,
    state character varying(100) NOT NULL,
    district character varying(100) NOT NULL,
    city character varying(100) NOT NULL,
    pincode character varying(20),
    region character varying(100),
    territory character varying(100),
    zone_id uuid,
    branch_type character varying(50),
    phone character varying(20),
    email character varying(255),
    manager_name character varying(200),
    opening_date date,
    last_audit_date date,
    operating_hours jsonb,
    latitude numeric(10,7),
    longitude numeric(10,7),
    location public.geometry(Point,4326),
    organization_id uuid,
    client_id uuid,
    risk_score numeric(5,2) DEFAULT '0'::numeric NOT NULL,
    risk_category character varying(20),
    complexity character varying(50) DEFAULT 'STANDARD'::character varying NOT NULL,
    estimated_duration_hours numeric(5,2) DEFAULT '8'::numeric NOT NULL,
    required_competencies jsonb
);


--
-- Name: business_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.business_rules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(150) NOT NULL,
    scope character varying(50) NOT NULL,
    target_id uuid,
    rule_type character varying(100) NOT NULL,
    conditions jsonb NOT NULL,
    actions jsonb
);


--
-- Name: call_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.call_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assessment_id uuid NOT NULL,
    assessor_id uuid NOT NULL,
    called_by uuid NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    outcome character varying(50) NOT NULL,
    negotiated_fee numeric(12,2),
    notes text
);


--
-- Name: capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capabilities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(100) NOT NULL,
    display_name character varying(100) NOT NULL,
    description text,
    category character varying(50)
);


--
-- Name: COLUMN capabilities.category; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.capabilities.category IS 'Logical grouping, e.g. PROJECT, ASSIGNMENT';


--
-- Name: capability_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.capability_permissions (
    capability_id uuid NOT NULL,
    permission_id uuid NOT NULL
);


--
-- Name: client_billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_billing (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_id uuid NOT NULL,
    payment_terms character varying(200) NOT NULL,
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    tax_identifier character varying(100),
    invoice_cycle character varying(50) NOT NULL,
    billing_address text NOT NULL,
    bank_account character varying(50),
    bank_name character varying(200),
    ifsc_code character varying(20),
    notes text,
    status character varying(20) DEFAULT 'DRAFT'::character varying NOT NULL,
    gst_rate numeric(6,2) DEFAULT '18'::numeric NOT NULL,
    tds_rate numeric(6,2) DEFAULT '10'::numeric NOT NULL
);


--
-- Name: client_billing_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_billing_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_id uuid NOT NULL,
    event_type character varying(30) NOT NULL,
    from_status character varying(20),
    to_status character varying(20),
    remarks text,
    field character varying(100),
    from_value text,
    to_value text
);


--
-- Name: client_configurations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_configurations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_id uuid NOT NULL,
    import_mapping jsonb,
    working_days jsonb,
    default_radius numeric(5,2) DEFAULT '50'::numeric NOT NULL,
    sla_rules jsonb,
    service_level character varying(50),
    max_response_time_hours integer,
    penalty_rate numeric(5,2),
    service_hours jsonb,
    effective_from timestamp with time zone NOT NULL,
    effective_to timestamp with time zone,
    travel_fee_per_km numeric(10,2),
    free_travel_allowance_km numeric(6,2),
    default_base_fee numeric(10,2)
);


--
-- Name: COLUMN client_configurations.import_mapping; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.import_mapping IS 'Custom mapping of Excel columns to FAPOMS schema fields';


--
-- Name: COLUMN client_configurations.working_days; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.working_days IS 'List of working days (0=Sunday, 1=Monday, ..., 6=Saturday)';


--
-- Name: COLUMN client_configurations.default_radius; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.default_radius IS 'Default assignment search radius in kilometers';


--
-- Name: COLUMN client_configurations.sla_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.sla_rules IS 'SLA parameters such as maximum response time, scheduling windows';


--
-- Name: COLUMN client_configurations.service_level; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.service_level IS 'SLA tier: PREMIUM, STANDARD, BASIC';


--
-- Name: COLUMN client_configurations.max_response_time_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.max_response_time_hours IS 'Maximum response time in hours';


--
-- Name: COLUMN client_configurations.penalty_rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.penalty_rate IS 'Penalty rate for SLA breaches (%)';


--
-- Name: COLUMN client_configurations.service_hours; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.service_hours IS 'Service hours configuration';


--
-- Name: COLUMN client_configurations.travel_fee_per_km; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.travel_fee_per_km IS 'Travel allowance per chargeable kilometre (INR). Null = platform default.';


--
-- Name: COLUMN client_configurations.free_travel_allowance_km; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.free_travel_allowance_km IS 'Local commute distance included in the base fee; travel is only chargeable beyond this. Null = platform default.';


--
-- Name: COLUMN client_configurations.default_base_fee; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_configurations.default_base_fee IS 'Base fee per branch audit used when an assayer has no active commercial profile. Null = platform default.';


--
-- Name: client_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_contacts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_id uuid NOT NULL,
    name character varying(200) NOT NULL,
    email character varying(255) NOT NULL,
    phone character varying(20) NOT NULL,
    designation character varying(200) NOT NULL,
    department character varying(200),
    is_primary boolean DEFAULT false NOT NULL,
    notes text
);


--
-- Name: client_contracts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_contracts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_id uuid NOT NULL,
    contract_number character varying(50) NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    signed_date date,
    effective_from date NOT NULL,
    effective_to date,
    value numeric(14,2),
    currency character varying(3) DEFAULT 'INR'::character varying NOT NULL,
    status character varying(50) DEFAULT 'DRAFT'::character varying NOT NULL,
    terms jsonb,
    document_url character varying(500)
);


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    client_code character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    display_name character varying(255) NOT NULL,
    website character varying(500),
    industry character varying(100),
    client_type character varying(50) DEFAULT 'OTHER'::character varying NOT NULL,
    registration_number character varying(100),
    tax_id character varying(100),
    lifecycle_status character varying(50) DEFAULT 'PROSPECT'::character varying NOT NULL,
    organization_id uuid,
    contact_person character varying(200),
    contact_email character varying(255),
    contact_phone character varying(20),
    address text,
    priority character varying(50) DEFAULT 'MEDIUM'::character varying NOT NULL,
    budget numeric(12,2),
    preferred_assayers jsonb,
    restricted_assayers jsonb,
    planning_preferences jsonb
);


--
-- Name: communications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.communications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assignment_id uuid NOT NULL,
    type public.communications_type_enum NOT NULL,
    content text NOT NULL,
    initiated_by uuid NOT NULL,
    recipient_ref character varying(150),
    is_delivered boolean DEFAULT true NOT NULL
);


--
-- Name: coverage_plan_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coverage_plan_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    coverage_plan_id uuid NOT NULL,
    "versionNumber" integer NOT NULL,
    "planData" jsonb NOT NULL,
    overrides jsonb,
    "changeJustification" text
);


--
-- Name: coverage_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coverage_plans (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_id uuid NOT NULL,
    status public.coverage_plans_status_enum DEFAULT 'DRAFT'::public.coverage_plans_status_enum NOT NULL,
    current_version integer DEFAULT 1 NOT NULL
);


--
-- Name: customer_master_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_master_versions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_id uuid NOT NULL,
    version_number integer NOT NULL,
    file_name character varying(255) NOT NULL,
    file_path text NOT NULL,
    total_rows integer DEFAULT 0 NOT NULL,
    unique_accounts integer DEFAULT 0 NOT NULL,
    duplicate_accounts integer DEFAULT 0 NOT NULL,
    status public.customer_master_versions_status_enum DEFAULT 'DRAFT'::public.customer_master_versions_status_enum NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    audit_date date
);


--
-- Name: customer_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_records (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    customer_master_version_id uuid NOT NULL,
    branch_id uuid,
    account_number character varying(100) NOT NULL,
    customer_name character varying(255) NOT NULL,
    packet_count integer DEFAULT 1 NOT NULL,
    declared_weight_grams numeric(10,2),
    previous_record_id uuid,
    raw_data jsonb
);


--
-- Name: device_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.device_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    user_id uuid NOT NULL,
    token character varying(500) NOT NULL,
    platform character varying(10) NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_branch_id uuid,
    assessment_id uuid,
    file_name character varying(255) NOT NULL,
    file_path text NOT NULL,
    file_size integer NOT NULL,
    mime_type character varying(100),
    type public.documents_type_enum NOT NULL,
    status public.documents_status_enum DEFAULT 'UPLOADED'::public.documents_status_enum NOT NULL,
    doc_version integer DEFAULT 1 NOT NULL,
    dispatched_at timestamp with time zone,
    dispatch_method character varying(20),
    dispatched_by uuid,
    received_at timestamp with time zone,
    sent_to_data_entry_at timestamp with time zone,
    sent_to_external_ocr_at timestamp with time zone,
    customer_master_version_id uuid,
    assigned_to_user_id uuid,
    assigned_at timestamp with time zone,
    assigned_by uuid,
    data_entry_completed_at timestamp with time zone
);


--
-- Name: geo_cities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geo_cities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(100) NOT NULL,
    district_id uuid NOT NULL,
    pincode character varying(10)
);


--
-- Name: geo_districts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geo_districts (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(100) NOT NULL,
    state_id uuid NOT NULL
);


--
-- Name: geo_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geo_states (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(100) NOT NULL,
    code character varying(10) NOT NULL
);


--
-- Name: holidays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.holidays (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(150) NOT NULL,
    date date NOT NULL,
    type character varying(20) DEFAULT 'NATIONAL'::character varying NOT NULL,
    applicable_states jsonb,
    year integer NOT NULL,
    client_id uuid
);


--
-- Name: COLUMN holidays.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.holidays.type IS 'Holiday type: NATIONAL, BANK, REGIONAL, CUSTOM';


--
-- Name: COLUMN holidays.applicable_states; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.holidays.applicable_states IS 'List of state codes where this holiday is observed. Empty = nationwide.';


--
-- Name: migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.migrations (
    id integer NOT NULL,
    "timestamp" bigint NOT NULL,
    name character varying NOT NULL
);


--
-- Name: migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.migrations_id_seq OWNED BY public.migrations.id;


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    user_id uuid,
    assayer_id uuid,
    category character varying(32) NOT NULL,
    in_app boolean DEFAULT true NOT NULL,
    push boolean DEFAULT true NOT NULL,
    email boolean DEFAULT false NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    user_id uuid,
    title character varying(255) NOT NULL,
    message text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    link character varying(255),
    assayer_id uuid,
    type character varying(64),
    category character varying(32) DEFAULT 'SYSTEM'::character varying NOT NULL,
    priority character varying(16) DEFAULT 'NORMAL'::character varying NOT NULL,
    status character varying(16) DEFAULT 'PENDING'::character varying NOT NULL,
    channels jsonb DEFAULT '["IN_APP"]'::jsonb NOT NULL,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    read_at timestamp with time zone,
    failed_at timestamp with time zone,
    failure_reason text,
    attempts integer DEFAULT 0 NOT NULL,
    entity_type character varying(64),
    entity_id uuid,
    payload jsonb,
    source_event_id uuid,
    actor_user_id uuid,
    dedupe_key character varying(200),
    group_key character varying(200)
);


--
-- Name: ocr_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ocr_jobs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    document_id uuid NOT NULL,
    external_job_id character varying(150),
    status public.ocr_jobs_status_enum DEFAULT 'PENDING'::public.ocr_jobs_status_enum NOT NULL,
    ocr_payload jsonb,
    retry_count integer DEFAULT 0 NOT NULL,
    failure_reason text,
    external_correlation_id character varying(150),
    last_attempt_at timestamp with time zone,
    next_retry_at timestamp with time zone,
    callback_received_at timestamp with time zone,
    completed_at timestamp with time zone
);


--
-- Name: operations_exceptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_exceptions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_id uuid NOT NULL,
    target_entity_id uuid,
    category public.operations_exceptions_category_enum NOT NULL,
    status public.operations_exceptions_status_enum DEFAULT 'UNRESOLVED'::public.operations_exceptions_status_enum NOT NULL,
    message text NOT NULL,
    "overrideJustification" text
);


--
-- Name: operations_execution_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_execution_conversations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    group_id uuid NOT NULL,
    sender public.operations_execution_conversations_sender_enum NOT NULL,
    message text NOT NULL,
    proposed_fee_override numeric(10,2),
    proposed_date_override date
);


--
-- Name: operations_execution_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_execution_groups (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    name text,
    status public.operations_execution_groups_status_enum DEFAULT 'DRAFT'::public.operations_execution_groups_status_enum NOT NULL,
    total_fee numeric(10,2) DEFAULT '0'::numeric NOT NULL,
    "logisticsPreferences" jsonb
);


--
-- Name: operations_field_incidents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_field_incidents (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    visit_id uuid NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    severity public.operations_field_incidents_severity_enum DEFAULT 'MEDIUM'::public.operations_field_incidents_severity_enum NOT NULL,
    status public.operations_field_incidents_status_enum DEFAULT 'REPORTED'::public.operations_field_incidents_status_enum NOT NULL,
    "resolutionDetails" text
);


--
-- Name: operations_field_visits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_field_visits (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    coverage_plan_id uuid NOT NULL,
    execution_group_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    assayer_id uuid NOT NULL,
    planned_date date NOT NULL,
    status public.operations_field_visits_status_enum DEFAULT 'READY'::public.operations_field_visits_status_enum NOT NULL,
    actual_start_time timestamp with time zone,
    actual_end_time timestamp with time zone,
    "evidenceReadiness" jsonb,
    "completionSummary" text
);


--
-- Name: operations_tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operations_tasks (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_id uuid NOT NULL,
    title text NOT NULL,
    reason text NOT NULL,
    priority public.operations_tasks_priority_enum DEFAULT 'MEDIUM'::public.operations_tasks_priority_enum NOT NULL,
    status public.operations_tasks_status_enum DEFAULT 'OPEN'::public.operations_tasks_status_enum NOT NULL,
    due_time timestamp with time zone,
    owner_id uuid,
    "resolutionJustification" text
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(200) NOT NULL,
    code character varying(50) NOT NULL,
    display_name character varying(200),
    description text,
    address text,
    contact_email character varying(150),
    contact_phone character varying(20),
    tax_id character varying(50),
    registration_number character varying(50)
);


--
-- Name: outbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_events (
    id uuid NOT NULL,
    event_name character varying(200) NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    dispatched_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error text
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    resource character varying(50) NOT NULL,
    action character varying(50) NOT NULL,
    scope character varying(50) NOT NULL,
    description text
);


--
-- Name: COLUMN permissions.resource; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions.resource IS 'Resource this permission applies to, e.g. PROJECT, ASSIGNMENT';


--
-- Name: COLUMN permissions.action; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions.action IS 'Action permitted, e.g. VIEW, CREATE, EDIT';


--
-- Name: COLUMN permissions.scope; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.permissions.scope IS 'Scope of the permission, e.g. SELF, ORGANIZATION, PLATFORM';


--
-- Name: platform_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_audit_logs (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    tenant_id uuid,
    user_id uuid NOT NULL,
    action text NOT NULL,
    before_state jsonb,
    after_state jsonb,
    justification text,
    ip_address character varying(50),
    correlation_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: project_branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.project_branches (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_id uuid NOT NULL,
    branch_id uuid NOT NULL,
    status public.project_branches_status_enum DEFAULT 'IMPORTED'::public.project_branches_status_enum NOT NULL,
    priority public.project_branches_priority_enum DEFAULT 'MEDIUM'::public.project_branches_priority_enum NOT NULL,
    zone_id uuid,
    scheduled_date date,
    remarks text,
    packet_count integer
);


--
-- Name: projects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.projects (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_number character varying(50) NOT NULL,
    name character varying(255) NOT NULL,
    description text,
    organization_id uuid,
    client_id uuid NOT NULL,
    status public.projects_status_enum DEFAULT 'DRAFT'::public.projects_status_enum NOT NULL,
    priority public.projects_priority_enum DEFAULT 'MEDIUM'::public.projects_priority_enum NOT NULL,
    start_date date,
    end_date date,
    budget numeric(12,2),
    scope text,
    required_skills jsonb,
    required_certifications jsonb,
    sla jsonb,
    risks jsonb,
    milestones jsonb,
    dependencies jsonb
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    token_hash character varying(255) NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    is_revoked boolean DEFAULT false NOT NULL,
    revoked_at timestamp with time zone,
    replaced_by uuid,
    ip_address character varying(50),
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: responsibilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.responsibilities (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(100) NOT NULL,
    display_name character varying(100) NOT NULL,
    description text
);


--
-- Name: responsibility_capabilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.responsibility_capabilities (
    responsibility_id uuid NOT NULL,
    capability_id uuid NOT NULL
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL
);


--
-- Name: role_responsibilities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_responsibilities (
    role_id uuid NOT NULL,
    responsibility_id uuid NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(50) NOT NULL,
    display_name character varying(100) NOT NULL,
    description text
);


--
-- Name: COLUMN roles.name; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.roles.name IS 'Machine-readable role identifier, e.g. OPERATIONS_MANAGER';


--
-- Name: schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedules (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assignment_id uuid NOT NULL,
    project_id uuid NOT NULL,
    assayer_id uuid NOT NULL,
    scheduled_date date NOT NULL,
    status public.schedules_status_enum DEFAULT 'TENTATIVE'::public.schedules_status_enum NOT NULL,
    remarks text,
    completed_at timestamp with time zone
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    username character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    first_name character varying(100) NOT NULL,
    last_name character varying(100) NOT NULL,
    display_name character varying(200) NOT NULL,
    status character varying(20) DEFAULT 'ACTIVE'::character varying NOT NULL,
    organization_id uuid,
    department_id uuid,
    phone character varying(20),
    last_login_at timestamp with time zone,
    failed_login_attempts integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    must_change_password boolean DEFAULT false NOT NULL
);


--
-- Name: COLUMN users.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.users.status IS 'User status: INVITED, ACTIVE, SUSPENDED, LOCKED, DISABLED, ARCHIVED';


--
-- Name: validation_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.validation_cases (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    project_branch_id uuid NOT NULL,
    assessment_id uuid,
    status public.validation_cases_status_enum DEFAULT 'PENDING'::public.validation_cases_status_enum NOT NULL,
    ocr_result jsonb,
    reviewer_id uuid,
    reviewed_at timestamp with time zone,
    remarks text,
    correction_notes text
);


--
-- Name: validation_queries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.validation_queries (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    validation_case_id uuid NOT NULL,
    assayer_id uuid NOT NULL,
    query_text text NOT NULL,
    target_field character varying(150),
    assayer_response text,
    responded_at timestamp with time zone,
    status public.validation_queries_status_enum DEFAULT 'OPEN'::public.validation_queries_status_enum NOT NULL,
    sla_due_date timestamp with time zone,
    attachments jsonb,
    document_id uuid,
    raised_by_user_id uuid,
    last_message_at timestamp with time zone
);


--
-- Name: validation_query_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.validation_query_messages (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    validation_query_id uuid NOT NULL,
    author_type public.validation_query_messages_author_type_enum NOT NULL,
    author_id uuid NOT NULL,
    author_name character varying(200),
    body text,
    attachments jsonb,
    page_number integer,
    region jsonb,
    snapshot_path character varying(500)
);


--
-- Name: workflow_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_history (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    "workflowKey" character varying NOT NULL,
    "entityId" character varying NOT NULL,
    "previousState" character varying NOT NULL,
    "newState" character varying NOT NULL,
    command character varying NOT NULL,
    "userId" character varying NOT NULL,
    "timestamp" timestamp without time zone DEFAULT now() NOT NULL,
    "correlationId" character varying NOT NULL
);


--
-- Name: workforce_attributes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workforce_attributes (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    assayer_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    name character varying(150) NOT NULL,
    level character varying(50),
    expiry_date timestamp with time zone,
    metadata jsonb
);


--
-- Name: zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zones (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    created_by character varying,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by character varying,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    name character varying(150) NOT NULL,
    description text,
    client_id uuid,
    states jsonb,
    districts jsonb
);


--
-- Name: COLUMN zones.states; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.zones.states IS 'List of state codes grouped under this zone';


--
-- Name: COLUMN zones.districts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.zones.districts IS 'List of district names grouped under this zone';


--
-- Name: migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations ALTER COLUMN id SET DEFAULT nextval('public.migrations_id_seq'::regclass);


--
-- Name: operations_execution_groups PK_18dfc89f21c977aa491777b22dd; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_execution_groups
    ADD CONSTRAINT "PK_18dfc89f21c977aa491777b22dd" PRIMARY KEY (id);


--
-- Name: billing_entries PK_1aa53e6d7cbc3df6e268260e9b8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entries
    ADD CONSTRAINT "PK_1aa53e6d7cbc3df6e268260e9b8" PRIMARY KEY (id);


--
-- Name: validation_cases PK_1b1c0e9fdf43b9de6e8c96a9070; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_cases
    ADD CONSTRAINT "PK_1b1c0e9fdf43b9de6e8c96a9070" PRIMARY KEY (id);


--
-- Name: client_contacts PK_1d0ab11dc872cb18d4850c970a5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contacts
    ADD CONSTRAINT "PK_1d0ab11dc872cb18d4850c970a5" PRIMARY KEY (id);


--
-- Name: audit_evidence PK_225dc4ed63867b5cbd9b364a80e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_evidence
    ADD CONSTRAINT "PK_225dc4ed63867b5cbd9b364a80e" PRIMARY KEY (id);


--
-- Name: user_roles PK_23ed6f04fe43066df08379fd034; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT "PK_23ed6f04fe43066df08379fd034" PRIMARY KEY (user_id, role_id);


--
-- Name: role_permissions PK_25d24010f53bb80b78e412c9656; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT "PK_25d24010f53bb80b78e412c9656" PRIMARY KEY (role_id, permission_id);


--
-- Name: communications PK_29ec793018d5d5ca19d40149e87; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communications
    ADD CONSTRAINT "PK_29ec793018d5d5ca19d40149e87" PRIMARY KEY (id);


--
-- Name: client_contracts PK_2b2c5b5b5ea51db7bd615d61c3d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT "PK_2b2c5b5b5ea51db7bd615d61c3d" PRIMARY KEY (id);


--
-- Name: holidays PK_3646bdd4c3817d954d830881dfe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.holidays
    ADD CONSTRAINT "PK_3646bdd4c3817d954d830881dfe" PRIMARY KEY (id);


--
-- Name: coverage_plans PK_4622d27b62a688a9b0c1753feaa; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coverage_plans
    ADD CONSTRAINT "PK_4622d27b62a688a9b0c1753feaa" PRIMARY KEY (id);


--
-- Name: operations_tasks PK_4964486c64ba124ae4369dff86b; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_tasks
    ADD CONSTRAINT "PK_4964486c64ba124ae4369dff86b" PRIMARY KEY (id);


--
-- Name: role_responsibilities PK_4bdf72468904c6ec9de01bee365; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_responsibilities
    ADD CONSTRAINT "PK_4bdf72468904c6ec9de01bee365" PRIMARY KEY (role_id, responsibility_id);


--
-- Name: assayer_payables PK_5879c7e1c94ced7723ea2789187; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_payables
    ADD CONSTRAINT "PK_5879c7e1c94ced7723ea2789187" PRIMARY KEY (id);


--
-- Name: operations_field_visits PK_5a75073c33e8670c387a82402d7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_field_visits
    ADD CONSTRAINT "PK_5a75073c33e8670c387a82402d7" PRIMARY KEY (id);


--
-- Name: capability_permissions PK_5c9c9dbcd3586012abeed7587ba; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_permissions
    ADD CONSTRAINT "PK_5c9c9dbcd3586012abeed7587ba" PRIMARY KEY (capability_id, permission_id);


--
-- Name: customer_master_versions PK_6141399f9459525e6c369c35cf0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_master_versions
    ADD CONSTRAINT "PK_6141399f9459525e6c369c35cf0" PRIMARY KEY (id);


--
-- Name: operations_exceptions PK_61cd69cc2dd379fec68ecc580f6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_exceptions
    ADD CONSTRAINT "PK_61cd69cc2dd379fec68ecc580f6" PRIMARY KEY (id);


--
-- Name: projects PK_6271df0a7aed1d6c0691ce6ac50; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT "PK_6271df0a7aed1d6c0691ce6ac50" PRIMARY KEY (id);


--
-- Name: assayer_remarks PK_64ce008981d342384d8ed4864c5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_remarks
    ADD CONSTRAINT "PK_64ce008981d342384d8ed4864c5" PRIMARY KEY (id);


--
-- Name: outbox_events PK_6689a16c00d09b8089f6237f1d2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_events
    ADD CONSTRAINT "PK_6689a16c00d09b8089f6237f1d2" PRIMARY KEY (id);


--
-- Name: notifications PK_6a72c3c0f683f6462415e653c3a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "PK_6a72c3c0f683f6462415e653c3a" PRIMARY KEY (id);


--
-- Name: organizations PK_6b031fcd0863e3f6b44230163f9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT "PK_6b031fcd0863e3f6b44230163f9" PRIMARY KEY (id);


--
-- Name: assayers PK_6ceb71d7ed721485307e436f847; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayers
    ADD CONSTRAINT "PK_6ceb71d7ed721485307e436f847" PRIMARY KEY (id);


--
-- Name: customer_records PK_720bc01e02237a56f8f885b7c41; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_records
    ADD CONSTRAINT "PK_720bc01e02237a56f8f885b7c41" PRIMARY KEY (id);


--
-- Name: client_billing PK_78d5a2fa2971bd764ae4a0ae55f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing
    ADD CONSTRAINT "PK_78d5a2fa2971bd764ae4a0ae55f" PRIMARY KEY (id);


--
-- Name: business_rules PK_7aee3b4a19978365c8832034d1d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.business_rules
    ADD CONSTRAINT "PK_7aee3b4a19978365c8832034d1d" PRIMARY KEY (id);


--
-- Name: refresh_tokens PK_7d8bee0204106019488c4c50ffa; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT "PK_7d8bee0204106019488c4c50ffa" PRIMARY KEY (id);


--
-- Name: schedules PK_7e33fc2ea755a5765e3564e66dd; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT "PK_7e33fc2ea755a5765e3564e66dd" PRIMARY KEY (id);


--
-- Name: branches PK_7f37d3b42defea97f1df0d19535; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT "PK_7f37d3b42defea97f1df0d19535" PRIMARY KEY (id);


--
-- Name: client_billing_history PK_7fbae248c34f1b3218e226fcf59; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing_history
    ADD CONSTRAINT "PK_7fbae248c34f1b3218e226fcf59" PRIMARY KEY (id);


--
-- Name: coverage_plan_versions PK_82b8319387b8d7b4df3531b129f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coverage_plan_versions
    ADD CONSTRAINT "PK_82b8319387b8d7b4df3531b129f" PRIMARY KEY (id);


--
-- Name: device_tokens PK_84700be257607cfb1f9dc2e52c3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.device_tokens
    ADD CONSTRAINT "PK_84700be257607cfb1f9dc2e52c3" PRIMARY KEY (id);


--
-- Name: zones PK_880484a43ca311707b05895bd4a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT "PK_880484a43ca311707b05895bd4a" PRIMARY KEY (id);


--
-- Name: project_branches PK_896ad4a1bb6cbdda0857674194e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_branches
    ADD CONSTRAINT "PK_896ad4a1bb6cbdda0857674194e" PRIMARY KEY (id);


--
-- Name: geo_states PK_8c288a05c0fac441b23ad684661; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_states
    ADD CONSTRAINT "PK_8c288a05c0fac441b23ad684661" PRIMARY KEY (id);


--
-- Name: workforce_attributes PK_8c54312080b1a5b31277ba23b52; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_attributes
    ADD CONSTRAINT "PK_8c54312080b1a5b31277ba23b52" PRIMARY KEY (id);


--
-- Name: migrations PK_8c82d7f526340ab734260ea46be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.migrations
    ADD CONSTRAINT "PK_8c82d7f526340ab734260ea46be" PRIMARY KEY (id);


--
-- Name: audit_events PK_910f64d901a5c3e9878f0d4a407; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT "PK_910f64d901a5c3e9878f0d4a407" PRIMARY KEY (id);


--
-- Name: permissions PK_920331560282b8bd21bb02290df; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT "PK_920331560282b8bd21bb02290df" PRIMARY KEY (id);


--
-- Name: assignment_comments PK_99976f728e0bca8642be0f2bec7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_comments
    ADD CONSTRAINT "PK_99976f728e0bca8642be0f2bec7" PRIMARY KEY (id);


--
-- Name: billing_invoices PK_9dbe3b4ca302c61707224bf3835; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT "PK_9dbe3b4ca302c61707224bf3835" PRIMARY KEY (id);


--
-- Name: assayer_commercial_profiles PK_a0c9e9990d118f3c2e56dd3fde5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_commercial_profiles
    ADD CONSTRAINT "PK_a0c9e9990d118f3c2e56dd3fde5" PRIMARY KEY (id);


--
-- Name: assayer_documents PK_a1ec06b8e9a6632170108bae880; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_documents
    ADD CONSTRAINT "PK_a1ec06b8e9a6632170108bae880" PRIMARY KEY (id);


--
-- Name: assessments PK_a3442bd80a00e9111cefca57f6c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessments
    ADD CONSTRAINT "PK_a3442bd80a00e9111cefca57f6c" PRIMARY KEY (id);


--
-- Name: users PK_a3ffb1c0c8416b9fc6f907b7433; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY (id);


--
-- Name: call_logs PK_aa08476bcc13bfdf394261761e9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT "PK_aa08476bcc13bfdf394261761e9" PRIMARY KEY (id);


--
-- Name: documents PK_ac51aa5181ee2036f5ca482857c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT "PK_ac51aa5181ee2036f5ca482857c" PRIMARY KEY (id);


--
-- Name: validation_queries PK_ac78360af11b421f3d54e21ce67; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_queries
    ADD CONSTRAINT "PK_ac78360af11b421f3d54e21ce67" PRIMARY KEY (id);


--
-- Name: operations_field_incidents PK_acc9a186f6a415a23e6b5f8e607; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_field_incidents
    ADD CONSTRAINT "PK_acc9a186f6a415a23e6b5f8e607" PRIMARY KEY (id);


--
-- Name: assignment_expenses PK_ada14c79a0de83540efe322a33d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_expenses
    ADD CONSTRAINT "PK_ada14c79a0de83540efe322a33d" PRIMARY KEY (id);


--
-- Name: assayer_government_documents PK_ae64169471c9aa963345102a121; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_government_documents
    ADD CONSTRAINT "PK_ae64169471c9aa963345102a121" PRIMARY KEY (id);


--
-- Name: audits PK_b2d7a2089999197dc7024820f28; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audits
    ADD CONSTRAINT "PK_b2d7a2089999197dc7024820f28" PRIMARY KEY (id);


--
-- Name: geo_cities PK_b4abb9549192a64532b3842d539; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_cities
    ADD CONSTRAINT "PK_b4abb9549192a64532b3842d539" PRIMARY KEY (id);


--
-- Name: geo_districts PK_ba73ad56ed2790fea574ae8a3fc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_districts
    ADD CONSTRAINT "PK_ba73ad56ed2790fea574ae8a3fc" PRIMARY KEY (id);


--
-- Name: roles PK_c1433d71a4838793a49dcad46ab; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "PK_c1433d71a4838793a49dcad46ab" PRIMARY KEY (id);


--
-- Name: billing_payments PK_c4e4866a41953b04f9229b273ce; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT "PK_c4e4866a41953b04f9229b273ce" PRIMARY KEY (id);


--
-- Name: assignments PK_c54ca359535e0012b04dcbd80ee; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "PK_c54ca359535e0012b04dcbd80ee" PRIMARY KEY (id);


--
-- Name: capabilities PK_c94fe6cafdb7646522a915893fd; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT "PK_c94fe6cafdb7646522a915893fd" PRIMARY KEY (id);


--
-- Name: branch_documents PK_ca59f6d5e330a5882c270716f39; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_documents
    ADD CONSTRAINT "PK_ca59f6d5e330a5882c270716f39" PRIMARY KEY (id);


--
-- Name: assayer_audit_history PK_d8e309a9b899b771433ffdb96b6; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_audit_history
    ADD CONSTRAINT "PK_d8e309a9b899b771433ffdb96b6" PRIMARY KEY (id);


--
-- Name: operations_execution_conversations PK_de4653853cf9d63465c7d1ee76b; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operations_execution_conversations
    ADD CONSTRAINT "PK_de4653853cf9d63465c7d1ee76b" PRIMARY KEY (id);


--
-- Name: platform_audit_logs PK_df9143ce2f97b20833a989e1e8c; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_audit_logs
    ADD CONSTRAINT "PK_df9143ce2f97b20833a989e1e8c" PRIMARY KEY (id);


--
-- Name: responsibilities PK_e22aa58654a4ecfe29d882b85eb; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibilities
    ADD CONSTRAINT "PK_e22aa58654a4ecfe29d882b85eb" PRIMARY KEY (id);


--
-- Name: client_configurations PK_e6ba3f6fd0a8592e4ba27b6044d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_configurations
    ADD CONSTRAINT "PK_e6ba3f6fd0a8592e4ba27b6044d" PRIMARY KEY (id);


--
-- Name: assayer_activities PK_e82c48d3008fbbf9710504ec510; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_activities
    ADD CONSTRAINT "PK_e82c48d3008fbbf9710504ec510" PRIMARY KEY (id);


--
-- Name: responsibility_capabilities PK_e980b65062a6816939142274671; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibility_capabilities
    ADD CONSTRAINT "PK_e980b65062a6816939142274671" PRIMARY KEY (responsibility_id, capability_id);


--
-- Name: billing_conflicts PK_eeb13293df6d2dee66e267fc882; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_conflicts
    ADD CONSTRAINT "PK_eeb13293df6d2dee66e267fc882" PRIMARY KEY (id);


--
-- Name: ocr_jobs PK_ef6e873087a3947edfb3f2499cc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_jobs
    ADD CONSTRAINT "PK_ef6e873087a3947edfb3f2499cc" PRIMARY KEY (id);


--
-- Name: clients PK_f1ab7cf3a5714dbc6bb4e1c28a4; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT "PK_f1ab7cf3a5714dbc6bb4e1c28a4" PRIMARY KEY (id);


--
-- Name: billing_history PK_f20ec465d981591343fecb3c9e3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_history
    ADD CONSTRAINT "PK_f20ec465d981591343fecb3c9e3" PRIMARY KEY (id);


--
-- Name: branch_contacts PK_fc86de9a802aece781d6ff85ca3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_contacts
    ADD CONSTRAINT "PK_fc86de9a802aece781d6ff85ca3" PRIMARY KEY (id);


--
-- Name: workflow_history PK_fea2a8522a65a196224b276dbd9; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_history
    ADD CONSTRAINT "PK_fea2a8522a65a196224b276dbd9" PRIMARY KEY (id);


--
-- Name: notification_preferences PK_notification_preferences; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT "PK_notification_preferences" PRIMARY KEY (id);


--
-- Name: schedules REL_1b1bb2cd81f25ee4761f4b1e0e; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT "REL_1b1bb2cd81f25ee4761f4b1e0e" UNIQUE (assignment_id);


--
-- Name: client_configurations REL_8997ef77f905e17348c021608f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_configurations
    ADD CONSTRAINT "REL_8997ef77f905e17348c021608f" UNIQUE (client_id);


--
-- Name: billing_entries UQ_0be5e4e1089f8c9712d045cbb7d; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entries
    ADD CONSTRAINT "UQ_0be5e4e1089f8c9712d045cbb7d" UNIQUE (entry_number);


--
-- Name: geo_states UQ_1052a8dd51ed7ea3757e2309902; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_states
    ADD CONSTRAINT "UQ_1052a8dd51ed7ea3757e2309902" UNIQUE (code);


--
-- Name: billing_conflicts UQ_186cd8f16a7d945d8b7625875fd; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_conflicts
    ADD CONSTRAINT "UQ_186cd8f16a7d945d8b7625875fd" UNIQUE (conflict_number);


--
-- Name: client_billing UQ_1b6a53cf635ea9e3e9327442a13; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing
    ADD CONSTRAINT "UQ_1b6a53cf635ea9e3e9327442a13" UNIQUE (client_id);


--
-- Name: client_contracts UQ_2f460572acbe646d21ba615cb0b; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT "UQ_2f460572acbe646d21ba615cb0b" UNIQUE (contract_number);


--
-- Name: assayers UQ_40271cf4d07407f77527423f86f; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayers
    ADD CONSTRAINT "UQ_40271cf4d07407f77527423f86f" UNIQUE (employee_id);


--
-- Name: geo_states UQ_43835a378d8336cd6817539f050; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_states
    ADD CONSTRAINT "UQ_43835a378d8336cd6817539f050" UNIQUE (name);


--
-- Name: billing_invoices UQ_536125305a544fe830cb6001869; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT "UQ_536125305a544fe830cb6001869" UNIQUE (invoice_number);


--
-- Name: roles UQ_648e3f5447f725579d7d4ffdfb7; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT "UQ_648e3f5447f725579d7d4ffdfb7" UNIQUE (name);


--
-- Name: clients UQ_7874e3c6cbb791a3bc75c9dcd71; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT "UQ_7874e3c6cbb791a3bc75c9dcd71" UNIQUE (client_code);


--
-- Name: assignments UQ_7c08693fc11883cd6b712a1fed2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "UQ_7c08693fc11883cd6b712a1fed2" UNIQUE (assignment_number);


--
-- Name: organizations UQ_7e27c3b62c681fbe3e2322535f2; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT "UQ_7e27c3b62c681fbe3e2322535f2" UNIQUE (code);


--
-- Name: assayer_payables UQ_829b0ef23f83c165ecf3e6718a8; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_payables
    ADD CONSTRAINT "UQ_829b0ef23f83c165ecf3e6718a8" UNIQUE (payable_number);


--
-- Name: capabilities UQ_87bf22fad6cc44a310239c17f63; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capabilities
    ADD CONSTRAINT "UQ_87bf22fad6cc44a310239c17f63" UNIQUE (name);


--
-- Name: users UQ_97672ac88f789774dd47f7c8be3; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE (email);


--
-- Name: projects UQ_a77b19582f25838ea68bbd4ffdf; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT "UQ_a77b19582f25838ea68bbd4ffdf" UNIQUE (project_number);


--
-- Name: assayers UQ_ac38fe8dfe44eb1ad3310e29fb0; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayers
    ADD CONSTRAINT "UQ_ac38fe8dfe44eb1ad3310e29fb0" UNIQUE (assayer_code);


--
-- Name: responsibilities UQ_f45353b6f25f81bea6ad271f85a; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibilities
    ADD CONSTRAINT "UQ_f45353b6f25f81bea6ad271f85a" UNIQUE (name);


--
-- Name: users UQ_fe0bb3f6520ee0469504521e710; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT "UQ_fe0bb3f6520ee0469504521e710" UNIQUE (username);


--
-- Name: validation_query_messages validation_query_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_query_messages
    ADD CONSTRAINT validation_query_messages_pkey PRIMARY KEY (id);


--
-- Name: IDX_00425d099a7654c37e7faffff0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_00425d099a7654c37e7faffff0" ON public.geo_districts USING btree (state_id);


--
-- Name: IDX_06773ea0f2d7b15d52f8427886; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_06773ea0f2d7b15d52f8427886" ON public.ocr_jobs USING btree (status);


--
-- Name: IDX_0903a7b0ed62fb4399c32004dd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0903a7b0ed62fb4399c32004dd" ON public.assignment_comments USING btree (assignment_id);


--
-- Name: IDX_0aea1ef40dff0b946da0b320ee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0aea1ef40dff0b946da0b320ee" ON public.operations_field_incidents USING btree (status);


--
-- Name: IDX_0ba3fc5b72aea38f4689c53e58; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0ba3fc5b72aea38f4689c53e58" ON public.billing_payments USING btree (payable_id);


--
-- Name: IDX_0d605a17e06f0df115b81a84d2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0d605a17e06f0df115b81a84d2" ON public.client_billing_history USING btree (client_id);


--
-- Name: IDX_0dff65957a13ec73746787b645; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0dff65957a13ec73746787b645" ON public.assayers USING btree (state);


--
-- Name: IDX_0f57a0c3adbbfd460935b7b046; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_0f57a0c3adbbfd460935b7b046" ON public.notifications USING btree (user_id, is_read, created_at);


--
-- Name: IDX_115fd6f187df6b472bffa010d6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_115fd6f187df6b472bffa010d6" ON public.billing_entries USING btree (project_id);


--
-- Name: IDX_15ddaded9b846811dfdd45b618; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_15ddaded9b846811dfdd45b618" ON public.documents USING btree (assessment_id);


--
-- Name: IDX_17022daf3f885f7d35423e9971; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_17022daf3f885f7d35423e9971" ON public.role_permissions USING btree (permission_id);


--
-- Name: IDX_178199805b901ccd220ab7740e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_178199805b901ccd220ab7740e" ON public.role_permissions USING btree (role_id);


--
-- Name: IDX_181a8cdaff4e1db94ff147163e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_181a8cdaff4e1db94ff147163e" ON public.branches USING btree (client_id);


--
-- Name: IDX_185983b933c14a781d441cb3ac; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_185983b933c14a781d441cb3ac" ON public.branch_documents USING btree (branch_id);


--
-- Name: IDX_18904497714587c1df720c5a8e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_18904497714587c1df720c5a8e" ON public.assessments USING btree (status);


--
-- Name: IDX_18b8aab3ad95fc3377bb998688; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_18b8aab3ad95fc3377bb998688" ON public.assignments USING btree (project_id);


--
-- Name: IDX_1cf095dc0dc701c3b0a7e02c92; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_1cf095dc0dc701c3b0a7e02c92" ON public.communications USING btree (type);


--
-- Name: IDX_1ee6d1efe4525c614d56b7306f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_1ee6d1efe4525c614d56b7306f" ON public.assayer_payables USING btree (status);


--
-- Name: IDX_20b3a9b5fc1907cbcaf7852e5c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_20b3a9b5fc1907cbcaf7852e5c" ON public.workforce_attributes USING btree (type, name);


--
-- Name: IDX_25c8eda59aef6d24e246bfe017; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_25c8eda59aef6d24e246bfe017" ON public.billing_invoices USING btree (client_id);


--
-- Name: IDX_2784fd924995f8b808f6a250a9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_2784fd924995f8b808f6a250a9" ON public.assayer_remarks USING btree (category);


--
-- Name: IDX_2c42294ef0e01015cc1979cdf7; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_2c42294ef0e01015cc1979cdf7" ON public.billing_invoices USING btree (status);


--
-- Name: IDX_2e1b11d26d549df02511f8fd30; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_2e1b11d26d549df02511f8fd30" ON public.billing_entries USING btree (level);


--
-- Name: IDX_2f130019c97be751122b72c380; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_2f130019c97be751122b72c380" ON public.assayer_remarks USING btree (assayer_id);


--
-- Name: IDX_32045c34a0bb890201c0bab25c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_32045c34a0bb890201c0bab25c" ON public.billing_entries USING btree (client_id);


--
-- Name: IDX_33237bf236c1cab79b27f255f2; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_33237bf236c1cab79b27f255f2" ON public.operations_tasks USING btree (project_id);


--
-- Name: IDX_35c088b5e3499861df82c13fe8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_35c088b5e3499861df82c13fe8" ON public.assayer_payables USING btree (client_id);


--
-- Name: IDX_3983a5b63b73ffa78f41131eb5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_3983a5b63b73ffa78f41131eb5" ON public.ocr_jobs USING btree (document_id);


--
-- Name: IDX_3b7b6f62b3e3eddbdb96ad306d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_3b7b6f62b3e3eddbdb96ad306d" ON public.validation_cases USING btree (status);


--
-- Name: IDX_3c166450c737779ebaab2bf408; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_3c166450c737779ebaab2bf408" ON public.holidays USING btree (year);


--
-- Name: IDX_3ddc983c5f7bcf132fd8732c3f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_3ddc983c5f7bcf132fd8732c3f" ON public.refresh_tokens USING btree (user_id);


--
-- Name: IDX_40271cf4d07407f77527423f86; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_40271cf4d07407f77527423f86" ON public.assayers USING btree (employee_id);


--
-- Name: IDX_40dfddee0c0d7125c767d8962b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_40dfddee0c0d7125c767d8962b" ON public.holidays USING btree (date);


--
-- Name: IDX_42d97150eb00982d34c088749b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_42d97150eb00982d34c088749b" ON public.branches USING gist (location);


--
-- Name: IDX_43b4c243ba5b2507a237e456ed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_43b4c243ba5b2507a237e456ed" ON public.operations_execution_groups USING btree (assayer_id);


--
-- Name: IDX_44323ed694ee4242b7ffe65320; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_44323ed694ee4242b7ffe65320" ON public.billing_history USING btree (assignment_id);


--
-- Name: IDX_443e5a24093230ca29133854d4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_443e5a24093230ca29133854d4" ON public.customer_master_versions USING btree (status);


--
-- Name: IDX_4766c7ea16f11eceb3da201281; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_4766c7ea16f11eceb3da201281" ON public.workforce_attributes USING btree (assayer_id);


--
-- Name: IDX_4abd688ca03553f70263ed55a5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_4abd688ca03553f70263ed55a5" ON public.assayer_government_documents USING btree (verification_status);


--
-- Name: IDX_4c14973824629aa19493141de4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_4c14973824629aa19493141de4" ON public.customer_master_versions USING btree (version_number);


--
-- Name: IDX_4d6a9d83ab4bba0cd24e5c9e8b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_4d6a9d83ab4bba0cd24e5c9e8b" ON public.operations_field_visits USING btree (status);


--
-- Name: IDX_4e139cc590fd5127ecc451472e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_4e139cc590fd5127ecc451472e" ON public.audit_events USING btree (occurred_at);


--
-- Name: IDX_510599024dee290e7cd7a5211c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_510599024dee290e7cd7a5211c" ON public.operations_field_visits USING btree (branch_id);


--
-- Name: IDX_51484015f2521fa95496cf61bf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_51484015f2521fa95496cf61bf" ON public.validation_queries USING btree (validation_case_id);


--
-- Name: IDX_51c604e01dda8b8b509e5ab18d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_51c604e01dda8b8b509e5ab18d" ON public.assayer_activities USING btree (assayer_id);


--
-- Name: IDX_52beb2467b495c0e237a6b5e51; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_52beb2467b495c0e237a6b5e51" ON public.billing_history USING btree (project_id);


--
-- Name: IDX_54d31f8e2afb3703d668b6aa6c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_54d31f8e2afb3703d668b6aa6c" ON public.assessments USING btree (project_id);


--
-- Name: IDX_557615b6faa9a5062da37b6433; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_557615b6faa9a5062da37b6433" ON public.call_logs USING btree (assessment_id);


--
-- Name: IDX_55cbe3e92921e38a60ccc2926e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_55cbe3e92921e38a60ccc2926e" ON public.project_branches USING btree (project_id);


--
-- Name: IDX_58cee923a7496fc0795c7297e9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_58cee923a7496fc0795c7297e9" ON public.operations_tasks USING btree (status);


--
-- Name: IDX_58d63563a5b476c04dcda2d228; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_58d63563a5b476c04dcda2d228" ON public.validation_queries USING btree (assayer_id);


--
-- Name: IDX_5bb6e02cbacdaa373751581ddd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_5bb6e02cbacdaa373751581ddd" ON public.billing_history USING btree (client_id);


--
-- Name: IDX_5c7623cfe8d008e1c1fd758fbc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_5c7623cfe8d008e1c1fd758fbc" ON public.audit_events USING btree (entity_type, entity_id);


--
-- Name: IDX_5e53679ddba47fd76f462f7a0b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_5e53679ddba47fd76f462f7a0b" ON public.call_logs USING btree (assessor_id);


--
-- Name: IDX_60e677583d6072e2f924fb4a11; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_60e677583d6072e2f924fb4a11" ON public.assignments USING btree (assessment_id);


--
-- Name: IDX_63deb99eec3bd3615257bc5567; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_63deb99eec3bd3615257bc5567" ON public.billing_conflicts USING btree (severity);


--
-- Name: IDX_640446f3b62db5ddf89cb7bfdf; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_640446f3b62db5ddf89cb7bfdf" ON public.call_logs USING btree (called_by);


--
-- Name: IDX_64410ab5b4fff05a986e08519d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_64410ab5b4fff05a986e08519d" ON public.assayer_government_documents USING btree (document_type);


--
-- Name: IDX_6577096b5a1206636f32c5dfb8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_6577096b5a1206636f32c5dfb8" ON public.assessments USING btree (branch_id);


--
-- Name: IDX_66969a729f0c24ff71d5ba18c4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_66969a729f0c24ff71d5ba18c4" ON public.assignments USING btree (project_branch_id);


--
-- Name: IDX_66f0789287cc73ca31dcefd5e4; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_66f0789287cc73ca31dcefd5e4" ON public.documents USING btree (type);


--
-- Name: IDX_6944cc76f6c31fbb6c9c321178; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_6944cc76f6c31fbb6c9c321178" ON public.billing_entries USING btree (payment_state);


--
-- Name: IDX_6f9ceea26025e6b324ec0ff11e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_6f9ceea26025e6b324ec0ff11e" ON public.operations_field_incidents USING btree (visit_id);


--
-- Name: IDX_709389d904fa03bdf5ec84998d; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_709389d904fa03bdf5ec84998d" ON public.documents USING btree (status);


--
-- Name: IDX_719f463c7996b212e17d1dbe65; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_719f463c7996b212e17d1dbe65" ON public.assayers USING btree (status);


--
-- Name: IDX_752ae72a520e96e2169c4163b8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_752ae72a520e96e2169c4163b8" ON public.customer_master_versions USING btree (project_id);


--
-- Name: IDX_77a151718caaddd3dafe3be8b1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_77a151718caaddd3dafe3be8b1" ON public.business_rules USING btree (scope, target_id);


--
-- Name: IDX_7839fac2ab3deda259a96f8ada; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7839fac2ab3deda259a96f8ada" ON public.notifications USING btree (category);


--
-- Name: IDX_7863112d98700a0c84a0cd14c3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7863112d98700a0c84a0cd14c3" ON public.communications USING btree (assignment_id);


--
-- Name: IDX_7b01c9df6d8b4ac90ee21fc8d3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7b01c9df6d8b4ac90ee21fc8d3" ON public.role_responsibilities USING btree (responsibility_id);


--
-- Name: IDX_7b48a680eb17f642cc36ff78d8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7b48a680eb17f642cc36ff78d8" ON public.branches USING btree (branch_code);


--
-- Name: IDX_7c08693fc11883cd6b712a1fed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7c08693fc11883cd6b712a1fed" ON public.assignments USING btree (assignment_number);


--
-- Name: IDX_7dcc7ff8e228a213d17c0038c3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7dcc7ff8e228a213d17c0038c3" ON public.validation_queries USING btree (status);


--
-- Name: IDX_7ee2763c8b773d2a6c3527b057; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_7ee2763c8b773d2a6c3527b057" ON public.billing_conflicts USING btree (status);


--
-- Name: IDX_80bb365b49abf378830ead6d22; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_80bb365b49abf378830ead6d22" ON public.assayer_government_documents USING btree (assayer_id);


--
-- Name: IDX_817a16e738499eea4b9805c535; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_817a16e738499eea4b9805c535" ON public.capability_permissions USING btree (capability_id);


--
-- Name: IDX_82e3f80ec1ce0a8e2d9d70b189; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_82e3f80ec1ce0a8e2d9d70b189" ON public.role_responsibilities USING btree (role_id);


--
-- Name: IDX_87b8888186ca9769c960e92687; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_87b8888186ca9769c960e92687" ON public.user_roles USING btree (user_id);


--
-- Name: IDX_8803b09002afad57b0df09c941; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8803b09002afad57b0df09c941" ON public.validation_query_messages USING btree (validation_query_id, created_at);


--
-- Name: IDX_89525f08c4404e13510846ee63; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_89525f08c4404e13510846ee63" ON public.customer_records USING btree (branch_id);


--
-- Name: IDX_8b054019e75531b50191d45d33; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8b054019e75531b50191d45d33" ON public.assayer_payables USING btree (assayer_id);


--
-- Name: IDX_8e9beb6c37bfcfbcf682527494; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8e9beb6c37bfcfbcf682527494" ON public.validation_cases USING btree (project_branch_id);


--
-- Name: IDX_8f3271787126b935872fd8cc3e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8f3271787126b935872fd8cc3e" ON public.customer_records USING btree (account_number);


--
-- Name: IDX_8fbedc9a1abc245b967e242ee0; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8fbedc9a1abc245b967e242ee0" ON public.billing_conflicts USING btree (entity_type);


--
-- Name: IDX_92f5d3a7779be163cbea7916c6; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_92f5d3a7779be163cbea7916c6" ON public.notifications USING btree (status);


--
-- Name: IDX_96463186d30836b893db822f58; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_96463186d30836b893db822f58" ON public.billing_entries USING btree (state);


--
-- Name: IDX_967a409cbb41310788ae903514; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_967a409cbb41310788ae903514" ON public.schedules USING btree (assayer_id);


--
-- Name: IDX_96d333aba805cd4ba8fe2978d3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_96d333aba805cd4ba8fe2978d3" ON public.billing_entries USING btree (assayer_id);


--
-- Name: IDX_9746d1392f63a8fa87b71240e3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9746d1392f63a8fa87b71240e3" ON public.billing_payments USING btree (assayer_id);


--
-- Name: IDX_97672ac88f789774dd47f7c8be; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_97672ac88f789774dd47f7c8be" ON public.users USING btree (email);


--
-- Name: IDX_977e24c520c49436d08e5eeea8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_977e24c520c49436d08e5eeea8" ON public.device_tokens USING btree (token);


--
-- Name: IDX_98d558b1357496cd28e94bff5a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_98d558b1357496cd28e94bff5a" ON public.documents USING btree (project_branch_id);


--
-- Name: IDX_9a8a82462cab47c73d25f49261; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9a8a82462cab47c73d25f49261" ON public.notifications USING btree (user_id);


--
-- Name: IDX_9cff1b5aaef83a219dd4bb7d6a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9cff1b5aaef83a219dd4bb7d6a" ON public.capability_permissions USING btree (permission_id);


--
-- Name: IDX_9ebaccbd26bb5f330e0d550ee7; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_9ebaccbd26bb5f330e0d550ee7" ON public.branches USING btree (region);


--
-- Name: IDX_a2074879da19ccd2e8cd1bc489; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a2074879da19ccd2e8cd1bc489" ON public.coverage_plan_versions USING btree (coverage_plan_id);


--
-- Name: IDX_a34540305eda79ea4b512da51b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a34540305eda79ea4b512da51b" ON public.responsibility_capabilities USING btree (capability_id);


--
-- Name: IDX_a54354500c368a87dce7bc33f3; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a54354500c368a87dce7bc33f3" ON public.operations_field_visits USING btree (assayer_id);


--
-- Name: IDX_a77b19582f25838ea68bbd4ffd; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a77b19582f25838ea68bbd4ffd" ON public.projects USING btree (project_number);


--
-- Name: IDX_a9cd9e9f57b31664785a0f3cfa; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_a9cd9e9f57b31664785a0f3cfa" ON public.billing_history USING btree (assayer_id);


--
-- Name: IDX_aa579396537ad5dae151616061; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_aa579396537ad5dae151616061" ON public.assayers USING btree (lifecycle_status);


--
-- Name: IDX_ac29f62dfb2ca8c62b241b641c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ac29f62dfb2ca8c62b241b641c" ON public.assayer_documents USING btree (assayer_id);


--
-- Name: IDX_ac38fe8dfe44eb1ad3310e29fb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ac38fe8dfe44eb1ad3310e29fb" ON public.assayers USING btree (assayer_code);


--
-- Name: IDX_b23c65e50a758245a33ee35fda; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_b23c65e50a758245a33ee35fda" ON public.user_roles USING btree (role_id);


--
-- Name: IDX_b4868c3ef09a06c4a7295b1684; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_b4868c3ef09a06c4a7295b1684" ON public.assayer_activities USING btree (occurred_at);


--
-- Name: IDX_b887356704b214c8c27a424f8c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_b887356704b214c8c27a424f8c" ON public.client_contracts USING btree (client_id);


--
-- Name: IDX_b931be929c2a7a4808e6aaaeff; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_b931be929c2a7a4808e6aaaeff" ON public.operations_execution_conversations USING btree (group_id);


--
-- Name: IDX_ba3bd69c8ad1e799c0256e9e50; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ba3bd69c8ad1e799c0256e9e50" ON public.refresh_tokens USING btree (expires_at);


--
-- Name: IDX_ba40808110cd4ad0f467eaf247; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ba40808110cd4ad0f467eaf247" ON public.operations_exceptions USING btree (project_id);


--
-- Name: IDX_be848e2770b2ca06dbe008366a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_be848e2770b2ca06dbe008366a" ON public.responsibility_capabilities USING btree (responsibility_id);


--
-- Name: IDX_c435f7555a7868a6cb0034b279; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_c435f7555a7868a6cb0034b279" ON public.assignment_expenses USING btree (assignment_id);


--
-- Name: IDX_c47f7966fb8af1fbfa916e2561; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_c47f7966fb8af1fbfa916e2561" ON public.device_tokens USING btree (user_id, platform);


--
-- Name: IDX_c76954510b334df511e6011461; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_c76954510b334df511e6011461" ON public.schedules USING btree (status);


--
-- Name: IDX_c794a324eee38eb5b63a2fbe34; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_c794a324eee38eb5b63a2fbe34" ON public.geo_cities USING btree (district_id);


--
-- Name: IDX_c9e358977735413db0d1a928df; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_c9e358977735413db0d1a928df" ON public.assayer_commercial_profiles USING btree (assayer_id);


--
-- Name: IDX_ca29f959102228649e71482747; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ca29f959102228649e71482747" ON public.projects USING btree (client_id);


--
-- Name: IDX_cc850f1a11cf8064c9b51a398b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cc850f1a11cf8064c9b51a398b" ON public.coverage_plans USING btree (project_id);


--
-- Name: IDX_ce3b086e1757a604547dff5d36; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ce3b086e1757a604547dff5d36" ON public.billing_payments USING btree (direction);


--
-- Name: IDX_ce6fc1fcaf3f268efa288ff5a7; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ce6fc1fcaf3f268efa288ff5a7" ON public.assignments USING btree (assayer_id);


--
-- Name: IDX_cff8d47d6171818e64aca8779a; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_cff8d47d6171818e64aca8779a" ON public.schedules USING btree (project_id);


--
-- Name: IDX_d034b39e07d216d3d428796882; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_d034b39e07d216d3d428796882" ON public.validation_cases USING btree (assessment_id);


--
-- Name: IDX_d3ebee0f092c731a50fc43199e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_d3ebee0f092c731a50fc43199e" ON public.assayers USING btree (organization_id);


--
-- Name: IDX_d577922d963695c90b61c67f3d; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_d577922d963695c90b61c67f3d" ON public.permissions USING btree (resource, action, scope);


--
-- Name: IDX_d5ace4f24abe554acb1a919656; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_d5ace4f24abe554acb1a919656" ON public.notifications USING btree (entity_type, entity_id);


--
-- Name: IDX_d8816e90be8612e215b6621d37; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_d8816e90be8612e215b6621d37" ON public.assayer_commercial_profiles USING btree (effective_start_date, effective_end_date);


--
-- Name: IDX_d893541df1e35cef989cc4bed9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_d893541df1e35cef989cc4bed9" ON public.project_branches USING btree (branch_id);


--
-- Name: IDX_d8af4b51ced8cc4961dd1f3fb5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_d8af4b51ced8cc4961dd1f3fb5" ON public.customer_records USING btree (customer_master_version_id);


--
-- Name: IDX_dac5d7acd8006ead52ea1767bb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_dac5d7acd8006ead52ea1767bb" ON public.billing_payments USING btree (invoice_id);


--
-- Name: IDX_daf1f626f9f30ced8991cdc179; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_daf1f626f9f30ced8991cdc179" ON public.branch_contacts USING btree (branch_id);


--
-- Name: IDX_db2468e1574cba4f38f44083d1; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_db2468e1574cba4f38f44083d1" ON public.audit_events USING btree (category);


--
-- Name: IDX_dcc26b94a9a58d40139c03889f; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_dcc26b94a9a58d40139c03889f" ON public.operations_exceptions USING btree (status);


--
-- Name: IDX_df0c82e06b9c20d7ebe1b1a232; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_df0c82e06b9c20d7ebe1b1a232" ON public.billing_history USING btree (entity_type, entity_id);


--
-- Name: IDX_df27f46f3230f2a790d405536e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_df27f46f3230f2a790d405536e" ON public.branches USING btree (zone_id);


--
-- Name: IDX_e12a47006c59a934a43a18565e; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e12a47006c59a934a43a18565e" ON public.assayers USING gist (location);


--
-- Name: IDX_e1c246079d669576b847df55d9; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e1c246079d669576b847df55d9" ON public.audit_events USING btree (user_id);


--
-- Name: IDX_e536b9d53cc6c920bdbcb94d06; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e536b9d53cc6c920bdbcb94d06" ON public.project_branches USING btree (status);


--
-- Name: IDX_e55231d765a247df2ff9a2644b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e55231d765a247df2ff9a2644b" ON public.assayer_documents USING btree (document_type);


--
-- Name: IDX_e58bf63cc50ef5e4503d6836df; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e58bf63cc50ef5e4503d6836df" ON public.outbox_events USING btree (dispatched_at, occurred_at);


--
-- Name: IDX_e5bd1d73c4f6cf99eef3348668; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e5bd1d73c4f6cf99eef3348668" ON public.billing_payments USING btree (payment_reference);


--
-- Name: IDX_e6dee4c7df64b1b110f466d44c; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e6dee4c7df64b1b110f466d44c" ON public.assignment_expenses USING btree (assayer_id, status);


--
-- Name: IDX_e9ac901a7381b56e9f0c762463; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_e9ac901a7381b56e9f0c762463" ON public.billing_history USING btree (created_at);


--
-- Name: IDX_ed88203149dc0c61c57fc27da5; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ed88203149dc0c61c57fc27da5" ON public.branches USING btree (sol_id);


--
-- Name: IDX_ee63dae13edda63dced3c53955; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ee63dae13edda63dced3c53955" ON public.billing_invoices USING btree (project_id);


--
-- Name: IDX_ef47f3aae4b36f0aaedbfc0416; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ef47f3aae4b36f0aaedbfc0416" ON public.client_contacts USING btree (client_id);


--
-- Name: IDX_ef49ab6a9dadb489ce0196237b; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_ef49ab6a9dadb489ce0196237b" ON public.assayers USING btree (manager_id);


--
-- Name: IDX_efe54c1fd40865977a2f380361; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_efe54c1fd40865977a2f380361" ON public.assayer_payables USING btree (assignment_id);


--
-- Name: IDX_f12148ce379462ebbb4d06cc13; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f12148ce379462ebbb4d06cc13" ON public.notifications USING btree (is_read);


--
-- Name: IDX_f7b26fa1afb0107c51c11a0459; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f7b26fa1afb0107c51c11a0459" ON public.assayer_payables USING btree (project_id);


--
-- Name: IDX_f8d76e845fa4dd486d0a5ac5a8; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_f8d76e845fa4dd486d0a5ac5a8" ON public.assayers USING gist (live_location);


--
-- Name: IDX_fbe89aad2c76db0a5365283d86; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_fbe89aad2c76db0a5365283d86" ON public.notifications USING btree (assayer_id);


--
-- Name: IDX_fbfd558dd94f3f65e86803e7fe; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_fbfd558dd94f3f65e86803e7fe" ON public.billing_entries USING btree (assignment_id);


--
-- Name: IDX_fe93525d97616feb04ceec8765; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_fe93525d97616feb04ceec8765" ON public.zones USING btree (client_id);


--
-- Name: UQ_notif_pref_assayer_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_notif_pref_assayer_cat" ON public.notification_preferences USING btree (assayer_id, category) WHERE (assayer_id IS NOT NULL);


--
-- Name: UQ_notif_pref_user_cat; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_notif_pref_user_cat" ON public.notification_preferences USING btree (user_id, category) WHERE (user_id IS NOT NULL);


--
-- Name: UQ_notifications_dedupe; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "UQ_notifications_dedupe" ON public.notifications USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);


--
-- Name: geo_districts FK_00425d099a7654c37e7faffff02; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_districts
    ADD CONSTRAINT "FK_00425d099a7654c37e7faffff02" FOREIGN KEY (state_id) REFERENCES public.geo_states(id);


--
-- Name: assignment_comments FK_0903a7b0ed62fb4399c32004dd0; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_comments
    ADD CONSTRAINT "FK_0903a7b0ed62fb4399c32004dd0" FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE CASCADE;


--
-- Name: billing_payments FK_0ba3fc5b72aea38f4689c53e588; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT "FK_0ba3fc5b72aea38f4689c53e588" FOREIGN KEY (payable_id) REFERENCES public.assayer_payables(id) ON DELETE SET NULL;


--
-- Name: billing_entries FK_115fd6f187df6b472bffa010d6c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entries
    ADD CONSTRAINT "FK_115fd6f187df6b472bffa010d6c" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: documents FK_15ddaded9b846811dfdd45b618d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT "FK_15ddaded9b846811dfdd45b618d" FOREIGN KEY (assessment_id) REFERENCES public.assessments(id) ON DELETE CASCADE;


--
-- Name: role_permissions FK_17022daf3f885f7d35423e9971e; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT "FK_17022daf3f885f7d35423e9971e" FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: role_permissions FK_178199805b901ccd220ab7740ec; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT "FK_178199805b901ccd220ab7740ec" FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: branches FK_181a8cdaff4e1db94ff147163e2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT "FK_181a8cdaff4e1db94ff147163e2" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- Name: branch_documents FK_185983b933c14a781d441cb3acc; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_documents
    ADD CONSTRAINT "FK_185983b933c14a781d441cb3acc" FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: assignments FK_18b8aab3ad95fc3377bb9986882; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "FK_18b8aab3ad95fc3377bb9986882" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: schedules FK_1b1bb2cd81f25ee4761f4b1e0e3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT "FK_1b1bb2cd81f25ee4761f4b1e0e3" FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE CASCADE;


--
-- Name: client_billing FK_1b6a53cf635ea9e3e9327442a13; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_billing
    ADD CONSTRAINT "FK_1b6a53cf635ea9e3e9327442a13" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: billing_invoices FK_25c8eda59aef6d24e246bfe0177; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT "FK_25c8eda59aef6d24e246bfe0177" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT;


--
-- Name: assayer_remarks FK_2f130019c97be751122b72c3801; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_remarks
    ADD CONSTRAINT "FK_2f130019c97be751122b72c3801" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: billing_entries FK_32045c34a0bb890201c0bab25c2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entries
    ADD CONSTRAINT "FK_32045c34a0bb890201c0bab25c2" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE RESTRICT;


--
-- Name: assignments FK_32278a9933ebc0c1686d9e56e95; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "FK_32278a9933ebc0c1686d9e56e95" FOREIGN KEY (execution_group_id) REFERENCES public.operations_execution_groups(id) ON DELETE SET NULL;


--
-- Name: ocr_jobs FK_3983a5b63b73ffa78f41131eb58; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ocr_jobs
    ADD CONSTRAINT "FK_3983a5b63b73ffa78f41131eb58" FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: workforce_attributes FK_4766c7ea16f11eceb3da2012818; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workforce_attributes
    ADD CONSTRAINT "FK_4766c7ea16f11eceb3da2012818" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: assignment_expenses FK_4a5697a8c998da889a69bfb81c3; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_expenses
    ADD CONSTRAINT "FK_4a5697a8c998da889a69bfb81c3" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: validation_query_messages FK_4b4593ccd4297c1ea44834524ce; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_query_messages
    ADD CONSTRAINT "FK_4b4593ccd4297c1ea44834524ce" FOREIGN KEY (validation_query_id) REFERENCES public.validation_queries(id) ON DELETE CASCADE;


--
-- Name: validation_queries FK_51484015f2521fa95496cf61bf7; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_queries
    ADD CONSTRAINT "FK_51484015f2521fa95496cf61bf7" FOREIGN KEY (validation_case_id) REFERENCES public.validation_cases(id) ON DELETE CASCADE;


--
-- Name: assayer_activities FK_51c604e01dda8b8b509e5ab18da; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_activities
    ADD CONSTRAINT "FK_51c604e01dda8b8b509e5ab18da" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: assessments FK_54d31f8e2afb3703d668b6aa6c4; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessments
    ADD CONSTRAINT "FK_54d31f8e2afb3703d668b6aa6c4" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: call_logs FK_557615b6faa9a5062da37b6433e; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT "FK_557615b6faa9a5062da37b6433e" FOREIGN KEY (assessment_id) REFERENCES public.assessments(id) ON DELETE CASCADE;


--
-- Name: project_branches FK_55cbe3e92921e38a60ccc2926e2; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_branches
    ADD CONSTRAINT "FK_55cbe3e92921e38a60ccc2926e2" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: call_logs FK_5e53679ddba47fd76f462f7a0b1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT "FK_5e53679ddba47fd76f462f7a0b1" FOREIGN KEY (assessor_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: assignments FK_60e677583d6072e2f924fb4a119; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "FK_60e677583d6072e2f924fb4a119" FOREIGN KEY (assessment_id) REFERENCES public.assessments(id) ON DELETE CASCADE;


--
-- Name: call_logs FK_640446f3b62db5ddf89cb7bfdf5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.call_logs
    ADD CONSTRAINT "FK_640446f3b62db5ddf89cb7bfdf5" FOREIGN KEY (called_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: assessments FK_6577096b5a1206636f32c5dfb81; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assessments
    ADD CONSTRAINT "FK_6577096b5a1206636f32c5dfb81" FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: assignments FK_66969a729f0c24ff71d5ba18c43; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "FK_66969a729f0c24ff71d5ba18c43" FOREIGN KEY (project_branch_id) REFERENCES public.project_branches(id) ON DELETE CASCADE;


--
-- Name: customer_master_versions FK_752ae72a520e96e2169c4163b85; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_master_versions
    ADD CONSTRAINT "FK_752ae72a520e96e2169c4163b85" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: communications FK_7863112d98700a0c84a0cd14c37; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.communications
    ADD CONSTRAINT "FK_7863112d98700a0c84a0cd14c37" FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE CASCADE;


--
-- Name: role_responsibilities FK_7b01c9df6d8b4ac90ee21fc8d3c; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_responsibilities
    ADD CONSTRAINT "FK_7b01c9df6d8b4ac90ee21fc8d3c" FOREIGN KEY (responsibility_id) REFERENCES public.responsibilities(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: assayer_government_documents FK_80bb365b49abf378830ead6d224; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_government_documents
    ADD CONSTRAINT "FK_80bb365b49abf378830ead6d224" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: capability_permissions FK_817a16e738499eea4b9805c535f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_permissions
    ADD CONSTRAINT "FK_817a16e738499eea4b9805c535f" FOREIGN KEY (capability_id) REFERENCES public.capabilities(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: role_responsibilities FK_82e3f80ec1ce0a8e2d9d70b189a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_responsibilities
    ADD CONSTRAINT "FK_82e3f80ec1ce0a8e2d9d70b189a" FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: user_roles FK_87b8888186ca9769c960e926870; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT "FK_87b8888186ca9769c960e926870" FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: customer_records FK_89525f08c4404e13510846ee63a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_records
    ADD CONSTRAINT "FK_89525f08c4404e13510846ee63a" FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: client_configurations FK_8997ef77f905e17348c021608fc; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_configurations
    ADD CONSTRAINT "FK_8997ef77f905e17348c021608fc" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: validation_cases FK_8e9beb6c37bfcfbcf6825274947; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_cases
    ADD CONSTRAINT "FK_8e9beb6c37bfcfbcf6825274947" FOREIGN KEY (project_branch_id) REFERENCES public.project_branches(id) ON DELETE CASCADE;


--
-- Name: schedules FK_967a409cbb41310788ae903514a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT "FK_967a409cbb41310788ae903514a" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: documents FK_98d558b1357496cd28e94bff5a6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT "FK_98d558b1357496cd28e94bff5a6" FOREIGN KEY (project_branch_id) REFERENCES public.project_branches(id) ON DELETE CASCADE;


--
-- Name: notifications FK_9a8a82462cab47c73d25f49261f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: capability_permissions FK_9cff1b5aaef83a219dd4bb7d6a0; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.capability_permissions
    ADD CONSTRAINT "FK_9cff1b5aaef83a219dd4bb7d6a0" FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: coverage_plan_versions FK_a2074879da19ccd2e8cd1bc4890; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coverage_plan_versions
    ADD CONSTRAINT "FK_a2074879da19ccd2e8cd1bc4890" FOREIGN KEY (coverage_plan_id) REFERENCES public.coverage_plans(id) ON DELETE CASCADE;


--
-- Name: responsibility_capabilities FK_a34540305eda79ea4b512da51be; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibility_capabilities
    ADD CONSTRAINT "FK_a34540305eda79ea4b512da51be" FOREIGN KEY (capability_id) REFERENCES public.capabilities(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: assayer_documents FK_ac29f62dfb2ca8c62b241b641c9; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_documents
    ADD CONSTRAINT "FK_ac29f62dfb2ca8c62b241b641c9" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: user_roles FK_b23c65e50a758245a33ee35fda1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT "FK_b23c65e50a758245a33ee35fda1" FOREIGN KEY (role_id) REFERENCES public.roles(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: client_contracts FK_b887356704b214c8c27a424f8cb; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contracts
    ADD CONSTRAINT "FK_b887356704b214c8c27a424f8cb" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: responsibility_capabilities FK_be848e2770b2ca06dbe008366a5; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.responsibility_capabilities
    ADD CONSTRAINT "FK_be848e2770b2ca06dbe008366a5" FOREIGN KEY (responsibility_id) REFERENCES public.responsibilities(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: assignment_expenses FK_c435f7555a7868a6cb0034b2795; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignment_expenses
    ADD CONSTRAINT "FK_c435f7555a7868a6cb0034b2795" FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE CASCADE;


--
-- Name: geo_cities FK_c794a324eee38eb5b63a2fbe344; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_cities
    ADD CONSTRAINT "FK_c794a324eee38eb5b63a2fbe344" FOREIGN KEY (district_id) REFERENCES public.geo_districts(id);


--
-- Name: assayer_commercial_profiles FK_c9e358977735413db0d1a928df6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assayer_commercial_profiles
    ADD CONSTRAINT "FK_c9e358977735413db0d1a928df6" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: projects FK_ca29f959102228649e714827478; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT "FK_ca29f959102228649e714827478" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: assignments FK_ce6fc1fcaf3f268efa288ff5a7a; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.assignments
    ADD CONSTRAINT "FK_ce6fc1fcaf3f268efa288ff5a7a" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: schedules FK_cff8d47d6171818e64aca8779af; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedules
    ADD CONSTRAINT "FK_cff8d47d6171818e64aca8779af" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE;


--
-- Name: validation_cases FK_d034b39e07d216d3d4287968822; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.validation_cases
    ADD CONSTRAINT "FK_d034b39e07d216d3d4287968822" FOREIGN KEY (assessment_id) REFERENCES public.assessments(id) ON DELETE SET NULL;


--
-- Name: project_branches FK_d893541df1e35cef989cc4bed99; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.project_branches
    ADD CONSTRAINT "FK_d893541df1e35cef989cc4bed99" FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: customer_records FK_d8af4b51ced8cc4961dd1f3fb57; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_records
    ADD CONSTRAINT "FK_d8af4b51ced8cc4961dd1f3fb57" FOREIGN KEY (customer_master_version_id) REFERENCES public.customer_master_versions(id) ON DELETE CASCADE;


--
-- Name: billing_payments FK_dac5d7acd8006ead52ea1767bb6; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_payments
    ADD CONSTRAINT "FK_dac5d7acd8006ead52ea1767bb6" FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id) ON DELETE CASCADE;


--
-- Name: branch_contacts FK_daf1f626f9f30ced8991cdc179d; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branch_contacts
    ADD CONSTRAINT "FK_daf1f626f9f30ced8991cdc179d" FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE CASCADE;


--
-- Name: billing_entries FK_e6e444ecd4064f06f43a926712b; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entries
    ADD CONSTRAINT "FK_e6e444ecd4064f06f43a926712b" FOREIGN KEY (invoice_id) REFERENCES public.billing_invoices(id) ON DELETE SET NULL;


--
-- Name: billing_invoices FK_ee63dae13edda63dced3c539555; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_invoices
    ADD CONSTRAINT "FK_ee63dae13edda63dced3c539555" FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE SET NULL;


--
-- Name: client_contacts FK_ef47f3aae4b36f0aaedbfc04161; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_contacts
    ADD CONSTRAINT "FK_ef47f3aae4b36f0aaedbfc04161" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: notifications FK_fbe89aad2c76db0a5365283d866; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT "FK_fbe89aad2c76db0a5365283d866" FOREIGN KEY (assayer_id) REFERENCES public.assayers(id) ON DELETE CASCADE;


--
-- Name: billing_entries FK_fbfd558dd94f3f65e86803e7fe9; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing_entries
    ADD CONSTRAINT "FK_fbfd558dd94f3f65e86803e7fe9" FOREIGN KEY (assignment_id) REFERENCES public.assignments(id) ON DELETE SET NULL;


--
-- Name: zones FK_fe93525d97616feb04ceec87658; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zones
    ADD CONSTRAINT "FK_fe93525d97616feb04ceec87658" FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--

