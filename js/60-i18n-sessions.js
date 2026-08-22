/* Tracker app — part 7/8: 60-i18n-sessions.js
   Appearance/theme, internationalization (the TRANSLATIONS dictionary + t / applyTranslations / setLanguage), Fleet data loading, and Sessions & sign-in-attempt admin.
   Split out of the original single-file index.html for maintainability; classic
   script, loaded in order with its siblings and sharing one global scope. */
    // ===== Appearance (Light / Dark theme) =====
    // ===== Language (English / Español) =====
    // First pass: navigation, login screen, and common header controls.
    // Not yet covered: form field labels within individual tabs, table
    // column headers, alert/confirm messages, and note-box help text — all
    // still English-only. Add more entries to TRANSLATIONS + tag more
    // elements with data-i18n to extend coverage over time.
    const TRANSLATIONS = {
        en: {
            welcome_prefix: 'Welcome,', role_label: 'Role:', company_label: 'Company:',
            synchronized: 'Synchronized', change_password_btn: 'Change Password', sign_out_btn: 'Sign Out',
            change_password_title: 'Change My Password', current_password: 'Current Password',
            new_password: 'New Password', confirm_new_password: 'Confirm New Password',
            save_password: 'Save Password', cancel: 'Cancel',
            group_logistics: 'Logistics', group_hr: 'HR & Payroll', group_admin: 'Administration',
            tab_tracker: 'Route Tracker', tab_report: 'Daily Report', tab_vehicles: 'Fleet',
            tab_notifications: 'Notifications', tab_employees: 'Employees', tab_claims: 'Claims & Charges',
            tab_charges: 'Charges & Income', tab_income: 'Income', tab_dailypay: 'Daily Pay', tab_statement: 'Statement',
            tab_payroll: 'Payroll', tab_settings: 'Settings', tab_users: 'Users', tab_companies: 'Companies',
            tab_approvals: 'Approvals', tab_log: 'Log', tab_data: 'Data Sync', tab_changelog: 'Changelog',
            login_title: 'Secure Login', username_label: 'Username', username_ph: 'Enter username',
            password_label: 'Password', sign_in_btn: 'Sign In',
            timeout_notice: 'You were signed out after 10 minutes of inactivity.',
            language_label: 'Language',
            language_note: 'Choose your language. This is saved on this device only, so other people signed in elsewhere keep their own preference. (Also available on the login screen.)',
            appearance_label: 'Appearance',
            clear_filters: '✕ Clear filters', sort_by: 'Sort by',
            new_contact: 'New Contact', next_id: 'Next ID', basic_info: 'Basic info',
            first_name: 'First Name', last_name: 'Last Name', person_type: 'Person Type',
            department: 'Department', role_title: 'Role / Title', start_date: 'Start Date',
            contact_info: 'Contact info', phone: 'Phone #', email: 'Email',
            identification: 'Identification', ssn_itin: 'SSN or ITIN #', type_label: 'Type',
            dl_or_state_id: 'Driver License or State ID #', dl_expiration: 'DL / State ID expiration',
            work_permit: 'Work Permit #', work_permit_exp: 'Work Permit expiration',
            medical_card: 'Medical Card', medical_card_exp: 'Medical Card expiration', notes: 'Notes',
            pay: 'Pay', pay_type: 'Pay Type', base_weekly_pay: 'Base Weekly Pay ($)',
            employee_note: 'Set <strong>Daily Rate</strong> for anyone whose pay changes week to week — enter their day-by-day amounts in the <strong>Daily Pay</strong> tab. On edit, leave <strong>SSN/ITIN</strong> blank to keep the stored number unchanged. Driver license, work permit, medical card and notes are shown openly in the directory; the SSN/ITIN stays hidden.',
            add_employee: 'Add Employee', cancel_edit: 'Cancel edit',
            search_employees_ph: 'Search name, ID, department, type...',
            export_csv: 'Export CSV', import_csv: 'Import CSV',
            th_id: 'ID', th_name: 'Name', th_type: 'Type', th_department: 'Department',
            th_start: 'Start', th_pay: 'Pay', th_status: 'Status', th_action: 'Action',
            new_claim: 'New Claim', next_claim_id: 'Next Claim ID', claimant_account: 'Claimant account',
            company_field: 'Company', employee_field: 'Employee', carrier_claim_num: 'Carrier claim #',
            customer_claim_num: 'Customer claim #', type_of_damage: 'Type of damage', claim_amount: 'Claim amount',
            weekly_deduction: 'Weekly deduction', start_deduction_date: 'Start deduction date',
            end_deduction_date: 'End deduction date', status_field: 'Status', absorbed_amount: 'Absorbed amount',
            weeks_needed_note: 'Weeks needed = claim amount ÷ weekly deduction (rounded up), calculated automatically.',
            save_claim: 'Save Claim', weekly_deduction_rate: 'Weekly deduction rate',
            new_weekly_amount: 'New weekly amount', effective_date: 'Effective date', add_rate_change: 'Add rate change',
            pause_resume: 'Pause / Resume', paused_date: 'Paused date', expected_resume: 'Expected resume (optional)',
            record_pause: 'Record pause', search_claims_ph: 'Search Claim ID, Employee, account, company...',
            import_excel_csv: 'Import Excel/CSV',
            th_claim_id: 'Claim ID', th_employee: 'Employee', th_emp_id: 'Emp. ID', th_claimant_acct: 'Claimant Acct',
            th_company: 'Company', th_carrier: 'Carrier #', th_customer: 'Customer #', th_damage_type: 'Damage Type',
            th_amount: 'Amount', th_weeks: 'Weeks', th_balance: 'Balance', th_absorbed: 'Absorbed', th_ends: 'Ends',
            employee_applies_both: 'Employee <span style="color:var(--text-muted); font-weight:400;">— for the new charge below</span>',
            new_charge: 'New Charge', next_charge_id: 'Next Charge ID', charge_type: 'Charge type', charge_amount: 'Charge amount',
            save_charge: 'Save Charge', search_charges_ph: 'Search charge ID, employee, type, status...',
            new_additional_income: 'New Additional Income', next_income_id: 'Next Income ID', income_type: 'Income type',
            total_amount: 'Total amount', weekly_amount: 'Weekly amount', end_date: 'End date',
            income_note: 'Additional income is <strong>added</strong> to the employee\'s pay each week (the opposite of a charge) — the weekly amount is paid out until the total is reached, then it stops automatically.',
            save_income: 'Save Income', search_income_ph: 'Search income ID, employee, type, status...',
            th_charge_id: 'Charge ID', th_income_id: 'Income ID', th_type: 'Type', th_weekly: 'Weekly', th_remaining: 'Remaining',
            // --- R1: shell, login 2FA step, overlays ---
            twofa_menu: 'Two-Factor Authentication', signout_other_devices: 'Sign out my other devices',
            two_step_title: 'Two-step verification',
            two_step_help: 'Enter the 6-digit code from your authenticator app. You can also use one of your recovery codes.',
            verify_btn: 'Verify', back_to_signin: '← Back to sign in',
            twofa_setup_title: 'Set up two-factor authentication',
            twofa_step1: '1. Add this account to an authenticator app',
            twofa_apps_note: 'Use Google Authenticator, Microsoft Authenticator, Authy, 1Password, or any TOTP app.',
            twofa_open_app: '📲 Open in authenticator app', twofa_manual_key: 'Or enter this key manually:',
            copy_btn: 'Copy', twofa_step2_label: '2. Enter the 6-digit code it shows',
            twofa_verify_on: 'Verify & turn on', try_again_btn: 'Try again', skip_for_now: 'Skip for now',
            twofa_is_on: '✅ Two-factor authentication is on', twofa_save_recovery: 'Save your recovery codes',
            twofa_recovery_help: 'Each code works once. If you ever lose your phone, a recovery code lets you sign in. Keep them somewhere safe — they are shown only now.',
            twofa_copy_codes: 'Copy codes', twofa_saved_ack: 'I have saved these recovery codes', done_btn: 'Done',
            twofa_intro_mandatory: 'Your role recommends two-factor authentication. Set it up now, or skip — we’ll remind you again in 15 days.',
            twofa_intro_optional: 'Add a second step at sign-in for extra security.',
            unusual_activity_title: 'Unusual sign-in activity', gso_cancel_admin: 'Cancel (admin)',
            gso_title: '🚪 Sign Out All Users', gso_everyone_pre: 'Everyone',
            gso_everyone_post: 'will get a countdown warning and then be signed out of all devices. Their unsaved work will be lost.',
            gso_grace_period: 'Grace period', mins_5: '5 minutes', mins_10: '10 minutes', mins_15: '15 minutes',
            mins_2: '2 minutes', mins_1: '1 minute', gso_reason_label: 'Reason (optional — shown to everyone)',
            gso_reason_ph: 'e.g. system maintenance', gso_type_pre: 'Type', gso_type_post: 'to confirm',
            gso_start: 'Start sign-out', gso_scope_all: 'in every company', gso_scope_company: 'in your company',
            idle_title: 'Still there?', idle_pre: 'You’ll be signed out in',
            idle_post: 's due to inactivity. Any unsaved changes could be lost.', idle_stay: 'Stay signed in',
            // --- R2: Settings, Home, Notifications ---
            id_config: 'ID Configuration',
            id_config_note: 'Changes here only affect <strong>new</strong> IDs going forward — Employee, Claim, and Charge IDs already assigned won\'t change. The ID <strong>prefix is the company code</strong> (set when a company is added), so switch companies up top to control it.',
            emp_id_digits: 'Employee ID digits', claim_id_digits: 'Claim ID digits', charge_id_digits: 'Charge ID digits',
            charge_id_suffix: 'Charge ID suffix', save_id_format: 'Save ID format',
            damage_type_panel: 'Type of Damage (Claims)', add_damage_type: 'Add a new damage type', damage_type_ph: 'e.g. Water damage',
            add_btn: 'Add', charge_type_panel: 'Charge Type (Charges)', add_charge_type: 'Add a new charge type', charge_type_ph: 'e.g. Advance',
            th_charge_type: 'Charge Type', income_type_panel: 'Additional Income Type', add_income_type: 'Add a new income type',
            income_type_ph: 'e.g. Bonus', th_income_type: 'Income Type',
            home_subtitle: 'Here\'s where things stand right now.',
            notif_note: 'New claims, charges, and additional income you\'ve been assigned show up here. Tap one to jump straight to it. View Only accounts only ever see their own — everyone else sees their whole company\'s, same as the rest of the app.',
            date_range: 'Date range', range_all: 'All time', range_30: 'Last 30 days', range_60: 'Last 60 days',
            range_90: 'Last 90 days', range_365: 'Last year', sort_short: 'Sort', opt_date: 'Date', mark_all_read: 'Mark all as read',
            // --- R3: Logistics (Tracker, Report, Fleet, Expiring) ---
            log_new_route: 'Log New Route', delivery_date: 'Delivery Date', route_type: 'Route Type', third_man: '3rd Man',
            driver: 'Driver', route_num: 'Route #', route_id: 'Route ID', miles: 'Miles', manifest_stops: 'Manifest Stops',
            pullbacks: 'Pullbacks', incompletes: 'Incompletes', dedicated_flat_pay: 'Dedicated Flat Pay', deductions: 'Deductions',
            extra_pay: 'Extra Pay', add_route: 'Add Route', th_regded: 'Reg/Ded', th_loaded: 'Loaded Stops',
            th_completed: 'Completed Stops', th_mileage_pay: 'Mileage pay', th_fuel_pay: 'Fuel pay', th_total_daily: 'Total Daily Pay',
            th_total_route: 'Total Pay per Route',
            year_label: 'Year', week_label: 'Week', expand_all: '➕ Expand All', collapse_all: '➖ Collapse All', row_labels: 'Row Labels',
            th_delivery_area: 'Delivery Area*', th_miles2: 'Miles**', th_manifest2: 'Manifest Stops**', th_pullbacks2: 'Pullbacks**',
            th_loaded2: 'Loaded Stops*', th_incompletes2: 'Incompletes*', th_completed2: 'Completed Stops*', th_mileage2: 'Mileage pay*',
            th_fuel2: 'Fuel pay**', th_thirdman2: '3rd. Man.**', th_dedicated_flat: 'Dedicated Flat*', th_deductions2: 'Deductions*',
            th_extra2: 'Extra Pay*', th_total_route2: 'Total Pay per Route*',
            add_vehicle_title: 'Add Vehicle', truck_num: 'Truck #', truck_num_ph: 'Company ID #', make: 'Make', make_ph: 'e.g. Freightliner',
            model: 'Model', model_ph: 'e.g. Cascadia', license_plate: 'License Plate', reg_expiry: 'Registration Expiry',
            ins_company: 'Insurance Company', policy_number: 'Policy Number', ins_expiry: 'Insurance Expiry', add_vehicle_btn: 'Add Vehicle',
            sched_maint: '📅 Schedule Maintenance', truck: 'Truck', date_label: 'Date', description: 'Description',
            sched_desc_ph: 'e.g. Oil Change, DOT Inspection', schedule_btn: '+ Schedule',
            vehicle_search_ph: 'Search truck #, year, make, model, plate, VIN...', export_btn: '⬇️ Export', import_btn: '⬆️ Import',
            opt_vehicle: 'Vehicle', opt_plate: 'Plate', opt_reg_exp: 'Reg. Expiry',
            expiring_title: 'Expiring Documents',
            expiring_note: 'Registration and insurance from Fleet, plus driver license, work permit, and medical card from Employees — all in one place, soonest first. Already-expired items show at the top.',
            show_within: 'Show within', days_30: '30 days', days_60: '60 days', days_90: '90 days', year_1: '1 year',
            everything_on_file: 'Everything on file', category: 'Category', all_categories: 'All categories', fleet_only: 'Fleet only',
            emp_docs_only: 'Employee documents only', expiring_search_ph: 'Search name, truck #...',
            // --- R3b: HR/Payroll (Statement, Daily Pay, Week Deposit, Provider Pay, Payroll, Savings & Release, Release History) ---
            all_types: 'All types', contractor: 'Contractor', opt_employee: 'Employee', opt_provider: 'Provider', opt_staff: 'Staff',
            active_opt: 'Active', inactive_opt: 'Inactive', all_statuses: 'All statuses', active_only: 'Active only',
            search_name_id_ph: 'Search name or ID...', prev_btn: '◀ Prev', next_btn: 'Next ▶', this_week: 'This week',
            print_btn: '🖨 Print', saved_flash: 'Saved ✓', select_employee_opt: '— Select employee —',
            optional_ph: 'optional', save_changes: '💾 Save changes',
            dailypay_title: 'Daily Pay Timesheet', import_registry: 'Import Registry',
            dailypay_note: 'Enter each person\'s pay for the days they worked (Sun–Sat). Tap <strong>OFF</strong> for days off — those are skipped in the week total. Entries save automatically and are kept per week, so you can browse any past week with the arrows. Only people set to <strong>Daily Rate</strong> appear here (change a person\'s pay type in the Employees tab).',
            weekdeposit_note: 'These are read from the existing <strong>Semana de Fondo</strong> charges already recorded on the Charges &amp; Income tab — a savings goal, built up week by week. This view doesn\'t create new ones; add a new deposit the same way as any other charge, using "Semana de Fondo" as the charge type.',
            edit_deposit: 'Edit Deposit', savings_goal: 'Savings Goal ($)', weekly_saving: 'Weekly Saving ($)',
            deducting_opt: 'Deducting', paid_opt: 'Paid', absorbed_opt: 'Absorbed',
            summary_report_excel: '📊 Summary Report (Excel)', summary_report_pdf: '📊 Summary Report (PDF)',
            providerpay_title: 'Provider Pay',
            providerpay_note: 'Enter each provider\'s pay for the week — a single amount, since providers aren\'t on a flat rate. Saves automatically and is kept per week, so you can browse any past week with the arrows. Only people set to <strong>Provider</strong> pay type appear here (change a person\'s pay type in the Employees tab). Feeds into Payroll the same way Daily Pay does. <strong>Linked to Bills Payable:</strong> any unpaid bill whose vendor matches a provider\'s name shows under that provider — tick one or more and tap “Pay selected” to mark those bills Paid and add their total to this week\'s amount.',
            payroll_title: 'Payroll Summary', print_all: '🖨 Print All',
            payroll_note: 'Net pay = base pay + route pay (drivers) + additional income − active weekly deductions (claims + charges currently being deducted). Base pay is the flat <strong>weekly salary</strong> for Weekly people, or this week\'s <strong>Daily Pay</strong> total for Daily-rate people. Route pay, additional income, and daily pay all use the current week.',
            savings_release_title: 'Savings & Release Eligibility',
            savingsrelease_note: 'Checks are issued Thursdays and handed over Saturdays. Week in Deposit can\'t be released earlier than <strong>90 days</strong> after an employee\'s Last Date Worked; that same employee\'s last week worked pay can\'t be released earlier than <strong>30 days</strong> after it. "Pending/outstanding" includes any claim or charge — any status — with a real balance, or (claims only) a leftover absorbed amount.',
            search_employee_ph: 'Search employee...', week_in_deposit_opt: 'Week in Deposit', last_paycheck_opt: 'Last Paycheck',
            all_eligibility: 'All eligibility', ready_release_now: 'Ready to release now', not_yet_eligible: 'Not yet eligible',
            release_history_title: 'Release History',
            releasehistory_note: 'Permanent record of every Week in Deposit and Last Paycheck release — original amount, what was deducted toward other claims/charges, and what actually reached the employee.',
            search_emp_releasedby_ph: 'Search employee, released by...',
            early_ontime: 'Early & on-time', early_only: 'Early only', ontime_only: 'On-time only',
            // --- R4: Messages, Invoices, Bills, Users, Companies, Approvals, Log, Data Sync, Changelog ---
            dm_search_ph: 'Search conversations...', pill_all: 'All', pill_general: 'General', pill_missing_day: 'Missing Day',
            pill_claims: 'Claims', pill_charges: 'Charges', pill_income: 'Income', dm_compose_ph: 'Type a message...',
            dm_empty_state: 'Select a person on the left to start a conversation.',
            new_invoice_title: 'New Invoice', edit_invoice_title: 'Edit Invoice', save_invoice_btn: 'Save Invoice', update_invoice_btn: 'Update Invoice',
            inv_number: 'Invoice #', inv_customer: 'Customer', inv_date: 'Invoice Date', due_date: 'Due Date', bill_to: 'Bill To',
            unpaid_opt: 'Unpaid', void_opt: 'Void',
            inv_number_ph: 'e.g. 0169', inv_customer_ph: 'e.g. Tramo', inv_billto_ph: 'Company, address, contact — as it appears on the invoice',
            line_items: 'Line Items', add_line: 'Add Line',
            invoice_search_ph: 'Search invoice #, customer, notes...', all_customers: 'All customers',
            new_bill_title: 'New Bill', edit_bill_title: 'Edit Bill', save_bill_btn: 'Save Bill', update_bill_btn: 'Update Bill',
            vendor: 'Vendor', vendor_bill_num: 'Vendor\'s Bill #', bill_date: 'Bill Date', amount_label: 'Amount',
            bill_vendor_ph: 'e.g. ABC Fuel Co, or pick a provider', bill_number_ph: 'e.g. INV-9001',
            bill_search_ph: 'Search vendor, bill #, notes...', all_vendors: 'All vendors',
            create_user_title: 'Create New User Profile', role_field: 'Role', assign_employee: 'Assign to Employee',
            create_user_btn: 'Create User', system_users: 'System Users', refresh_btn: 'Refresh',
            active_sessions: 'Active sessions', session_signout_note: 'Signing a session out takes effect immediately.',
            failed_signins: 'Recent failed sign-ins',
            failed_signins_note: 'Last 7 days. An account locks for 5 minutes after 5 failures; a network locks for 15 minutes after 30.',
            gso_history: 'Global sign-out history',
            gso_history_note: 'Every \'Sign Out All Users\' action: who started it, when, why, and how many were affected.',
            add_company_title: 'Add Company', add_company_btn: 'Add Company', save_changes_plain: 'Save changes', editing_prefix: 'Editing',
            company_section: 'Company', company_code: 'Company Code (3–4 chars)', company_name: 'Company Name',
            ownership_contact: 'Ownership & contact', owner_label: 'Owner', manager_label: 'Manager', manager_phone: 'Manager Phone #',
            company_code_ph: 'e.g. 3FL', company_name_ph: 'e.g. 3 Of Life LLC', owner_ph: 'Owner name', phone_ph: '(555) 555-5555',
            email_ph: 'name@example.com', manager_ph: 'Manager name', companies_title: 'Companies',
            pending_approvals: 'Pending Approvals',
            approvals_note: 'Locked financial changes (base pay rate, claim amount, weekly deduction) requested by Medium users appear here for Administrator approval.',
            pending_release_requests: 'Pending Release Requests',
            release_requests_note: 'A Medium user\'s Week in Deposit or Last Paycheck release — normal or early — always lands here first. Nothing is released until an Administrator approves it.',
            change_log_title: 'Change Log',
            log_note: 'Every applied change to employees, claims, charges, and routes is recorded here.',
            export_data_title: 'Export Data', download_excel_backup: '⬇️ Download Excel Backup (Route Tracker only)',
            export_all_data: '⬇️ Export All Data (single file)',
            export_all_note: 'One .xlsx file with a separate sheet for Employees, Claims, Charges, Additional Income, Vehicles, Routes, Daily Pay, and Provider Pay — everything you have access to, in one download. Employee SSN/ITIN is never included in any export.',
            import_all_title: 'Import All Data (single file)',
            import_all_note: 'Upload a file exported from <strong>Export All Data</strong> above (or hand-edited to match its column layout) to restore Claims, Charges, Additional Income, Vehicles, Routes, Daily Pay, and Provider Pay in one pass — matched to existing employees by Employee ID. Doesn\'t touch Employees themselves; use Import CSV on the Employees tab for that.',
            import_sync_routes_title: 'Import & Sync Routes from Excel (Tab: Tracker)',
            admin_danger_title: 'Administrator Management & Reset Zone',
            admin_danger_note: 'These actions are restricted to <strong>Administrator</strong> users only.',
            del_all_routes: '🗑️ Delete All Routes', del_all_claims: '🗑️ Delete All Claims', del_all_charges: '🗑️ Delete All Charges',
            del_all_users: '🗑️ Delete All Users', reset_all_except_users: '⚠️ Reset All Data (Except Users)',
            gso_signout_note: 'Gives everyone a countdown warning, then signs them out of all devices. Administrators affect their own company; Super Admin affects everyone.',
            sysreset_title: 'System Reset — Super Admin Only',
            sysreset_note: 'Removes every user account except Super Admins, and clears the audit Log and pending Approvals. Companies and everything that belongs to them — employees, claims, charges, routes, income — are <strong>not</strong> touched. Cannot be undone.',
            reset_system_btn: '☢️ Reset System (Keep Companies & Super Admin)',
            changelog_title: 'Changelog',
            changelog_note: 'Every change delivered to this app, newest first — stored server-side so this history survives even across app file changes. Only visible to Super Admin.',
            search_results_title: 'Search results',
            // --- R4b: record-grid sort-dropdown options ---
            sort_kind: 'Kind', sort_start_ded: 'Start ded.', sort_start: 'Start', sort_base: 'Base (wk)',
            sort_gross: 'Gross', sort_net: 'Net', sort_bill_num: 'Bill #', sort_employee_id: 'Employee ID',
            sort_created: 'Created', sort_code: 'Code', sort_requested: 'Requested', sort_requested_by: 'Requested by',
            sort_table: 'Table', sort_field: 'Field', sort_when: 'When', sort_who: 'Who',
            // --- R5a: dynamic card chrome — Employees & Fleet ---
            d_type: 'Type', d_department: 'Department', d_start_date: 'Start date', d_pay: 'Pay', d_status: 'Status',
            d_edit: 'Edit', d_delete: '✕ Delete', d_phone: 'Phone', d_email: 'Email', d_ssn_itin: 'SSN / ITIN',
            d_dl_stateid: 'Driver License / State ID', d_dl_exp: 'DL Expiration', d_wp_num: 'Work Permit #', d_wp_exp: 'Work Permit Expiration',
            d_medcard: 'Medical Card', d_medcard_exp: 'Medical Card Expiration', d_role_title: 'Role / Title', d_notes: 'Notes',
            d_status_history: 'Status history', d_generate_user: 'Generate User', d_loading: 'Loading…',
            d_no_status_changes: 'No status changes recorded yet.', d_th_date: 'Date', d_th_change: 'Change', d_th_by: 'By',
            d_no_employees: 'No employees found.', d_no_vehicles: 'No vehicles yet.', d_nothing_expiring: 'Nothing expiring in this window.',
            d_no_upcoming_maint: 'No upcoming maintenance scheduled.', d_no_service_records: 'No service records yet.',
            d_already_expired: 'Already expired', d_within_14: 'Within 14 days', d_total_shown: 'Total shown',
            d_edit_vehicle_record: '✎ Edit vehicle record', d_edit_employee_record: '✎ Edit employee record',
            d_stat_fleet: 'Fleet', d_stat_reg_exp: 'Reg. expiring/expired', d_stat_ins_exp: 'Insurance expiring/expired',
            d_th_id: 'ID', d_th_truck: 'Truck #', d_th_vehicle: 'Vehicle', d_th_plate: 'Plate', d_th_reg_exp: 'Reg. Expiry',
            d_th_ins_co: 'Insurance Co.', d_th_ins_exp: 'Insurance Expiry',
            d_reg_expiry: 'Registration expiry', d_insurance_company: 'Insurance company', d_policy_num: 'Policy #', d_insurance_expiry: 'Insurance expiry',
            d_license_plate: 'License plate', d_vin: 'VIN', d_service_log: 'Service Log', d_mileage_at_service: 'Mileage at service',
            d_next_service_due: 'Next service due at', d_add: '+ Add', d_service_desc_ph: 'e.g. Oil Change, Tire Rotation',
            // --- R5a: dynamic card chrome — Claims, Charges, Income ---
            d_no_cc: 'No claims or charges found.', d_th_kind: 'Kind', d_employee: 'Employee', d_employee_id: 'Employee ID',
            d_claimant_acct: 'Claimant acct', d_company: 'Company', d_carrier_claim: 'Carrier claim #', d_customer_claim: 'Customer claim #',
            d_type_damage: 'Type of damage', d_claim_amount: 'Claim amount', d_weeks: 'Weeks', d_balance: 'Balance', d_absorbed: 'Absorbed',
            d_start_ded: 'Start ded.', d_end_ded: 'End ded.', d_edit_full: '✎ Edit',
            d_charge_type: 'Charge type', d_amount: 'Amount', d_weekly_deduction: 'Weekly deduction',
            d_income_type: 'Income type', d_weekly_amount: 'Weekly amount', d_start: 'Start', d_ends: 'Ends',
            d_no_income: 'No additional income found.',
            d_income_setup_note: 'Run the income setup SQL (the <strong>additional_income</strong> table) to start logging additional income.',
            d_th_effective: 'Effective', d_th_weekly: 'Weekly', d_no_rate_changes: 'No rate changes — using the base weekly amount.',
            d_th_paused: 'Paused', d_th_resume: 'Resume', d_no_pauses: 'No pauses recorded yet.',
            // --- R5a: dynamic card chrome — Payroll ---
            d_no_people_match: 'No people match these filters.', d_th_name: 'Name',
            d_base_wk: 'Base (wk)', d_route_wk: 'Route (wk)', d_income_wk: 'Income (wk)', d_gross: 'Gross', d_deductions_h: 'Deductions', d_net: 'Net',
            d_base_pay_wk: 'Base pay (wk)', d_route_pay_wk: 'Route pay (wk)', d_weekly_deductions: 'Weekly deductions', d_net_pay: 'Net pay',
            d_people: 'People', d_gross_wk: 'Gross (wk)', d_deductions_wk: 'Deductions (wk)', d_net_pay_wk: 'Net Pay (wk)',
            d_th_day: 'Day', d_th_pay: 'Pay', d_base_daily_total: 'Base (daily total)', d_provider_pay: 'Provider pay', d_weekly_salary: 'Weekly salary',
            d_route_pay_dot: 'Route pay', d_th_route: 'Route', d_route_total: 'Route total',
            d_no_daily_pay: 'No daily pay entered for', d_no_provider_pay: 'No provider pay entered for',
            d_additional_income: 'Additional income', d_income_total: 'Income total', d_total_deductions: 'Total deductions', d_no_active_ded: 'No active weekly deductions.',
            d_print_payslip: '🖨 Print payslip', d_paid_days_base: 'Paid days / base pay',
            // --- R5a: dynamic card chrome — Statement, Week Deposit, Savings/Release, Release History, Pay ---
            d_stat_claims: 'Claims', d_stat_charges: 'Charges', d_stat_add_income: 'Additional income',
            d_total_claims: 'Total claims', d_total_charges: 'Total charges', d_total_income: 'Total income',
            d_select_emp_stmt: 'Select an employee above to see their statement.', d_current_deductions: 'Current deductions — full breakdown',
            d_no_current_cc: 'No current claims or charges for this employee.', d_add_income_breakdown: 'Additional income — full breakdown',
            d_claimant_account: 'Claimant account', d_weekly_rate: 'Weekly rate', d_weeks_to_zero: 'Weeks to $0', d_paid_so_far: 'Paid so far',
            d_print_schedule: '🖨 Print schedule', d_th_deducted: 'Deducted', d_th_running_balance: 'Running balance',
            d_no_schedule_claim: 'No schedule to project — the claim is resolved, or needs a start date and weekly amount.',
            d_no_schedule_charge: 'No schedule to project — the charge is resolved, or needs a start date and weekly amount.',
            d_weekly: 'Weekly', d_remaining: 'Remaining',
            d_goal: 'Goal', d_weekly_saving: 'Weekly saving', d_saved_so_far: 'Saved so far', d_remaining_to_goal: 'Remaining to goal',
            d_of_goal: 'of goal', d_release: '🔓 Release', d_early_release: '⏰ Early Release', d_th_saved_week: 'Saved that week',
            d_total_saved: 'Total saved', d_active_deposits: 'Active deposits', d_total_remaining: 'Total remaining', d_no_deposits: 'No deposits found.',
            d_ready_now: 'Ready to release now', d_total_tracked: 'Total tracked', d_wid_savings: 'Week in Deposit savings',
            d_nothing_savings: 'Nothing to show — no open Week in Deposit savings and no Inactive employees with an unreleased last paycheck (matching the current filters).',
            d_pending_elsewhere: 'Pending/outstanding elsewhere', d_eligible_date: 'Eligible date', d_check_issued: 'Check issued (Thu)',
            d_handed_over: 'Handed over (Sat)', d_not_eligible_until: 'Not eligible until',
            d_total_releases: 'Total Releases', d_net_released_emp: 'Net Released to Employees', d_total_applied_ded: 'Total Applied to Deductions',
            d_early_releases: 'Early Releases', d_no_releases: 'No releases recorded yet (matching the current filters).',
            d_base_pay: 'Base Pay', d_additional_income_c: 'Additional Income', d_original_amount: 'Original Amount',
            d_total_deductions_c: 'Total Deductions', d_final_released: 'Final Amount Released', d_requested_via: 'Requested via approval?',
            d_applied_to: 'Applied to', d_no_other_outstanding: 'No other outstanding claims or charges at the time of release.', d_by: 'by',
            d_no_pending_release: 'No pending release requests.', d_net_to_release: 'Net to Release', d_requested: 'Requested', d_plan: 'Plan',
            d_no_other_cc: 'No other outstanding claims or charges.', d_approve: 'Approve', d_reject: '✕ Reject', d_requested_by: 'requested by',
            d_no_provider_set: 'No one is set to <strong>Provider</strong> pay yet. Go to the Employees tab and switch a person\'s Pay to <em>Provider</em>.',
            d_amount_this_week: 'Amount this week', d_notes_optional: 'Notes (optional)', d_provider_notes_ph: 'e.g. invoice #, what for', d_total_this_week: 'Total this week',
            d_dp_setup: '⚙️ <strong>One-time setup needed.</strong> The daily-pay tables don\'t exist in your database yet, so entries can\'t be saved. Ask your admin to run the short SQL setup (provided with this update) in Supabase → SQL Editor. Everything else in the app keeps working normally.',
            d_no_daily_set: 'No one is set to <strong>Daily Rate</strong> yet. Go to the Employees tab and switch a person\'s Pay to <em>Daily</em> (the ↺ button in the Pay column).',
            d_week_total: 'Week Total',
            // --- R5a: dynamic card chrome — Companies, Invoices, Bills, Approvals, Log, Notifications, Messages, Home, Changelog, Users/Sessions ---
            d_no_companies: 'No companies yet.', d_created: 'Created', d_manager_phone: 'Manager Phone',
            d_no_line_items: 'No line items.', d_no_line_items_hint: 'No line items yet — click "+ Add Line", or just save with the total below alone.', d_desc_route_ph: 'Description / route', d_rate_ph: 'Rate', d_qty_ph: 'Qty', d_extra_ph: 'Extra', d_amount_ph: 'Amount',
            d_stat_unpaid: 'Unpaid', d_invoiced_month: 'Invoiced This Month', d_total_invoices: 'Total Invoices', d_no_invoices: 'No invoices found.',
            d_overdue: 'Overdue', d_total_bills: 'Total Bills', d_no_bills: 'No bills found.',
            d_no_pending: 'No pending requests.', d_th_requested_by: 'Requested By', d_th_record: 'Record', d_th_old: 'Old', d_th_new: 'New', d_th_requested: 'Requested',
            d_record: 'Record', d_old_value: 'Old value', d_new_value: 'New value',
            d_no_changes_logged: 'No changes logged yet.',
            d_no_notifs: 'No notifications in this range.',
            d_no_convos: 'No conversations yet. Tap + to start one.', d_you_prefix: 'You:', d_new_conversation: 'New conversation', d_pick_person: '— Pick a person —', d_open_chat: 'Open chat',
            d_home_active_emps: 'Active Employees', d_home_open_claims: 'Open Claims', d_home_active_charges: 'Active Charges', d_home_income_week: 'Income This Week', d_home_expiring: 'Expiring Soon', d_home_unread: 'Unread Notifications',
            d_no_versions: 'No versions logged yet.', d_current: 'Current',
            d_no_sessions: 'No active sessions.', d_th_user: 'User', d_th_started: 'Started', d_th_last_seen: 'Last seen', d_th_ends: 'Ends', d_sign_out_btn: 'Sign out', d_this_device: 'This device',
            d_no_failed: 'No failed sign-ins in the last 7 days.', d_th_type: 'Type', d_th_who: 'Who', d_th_failed: 'Failed', d_th_last_attempt: 'Last attempt',
            d_no_users: 'No users found.', d_restricted: 'Restricted', d_id_btn: '🪪 ID', d_reset_pw: '🔑 Reset', d_reset_2fa: '🔐 Reset 2FA',
            d_no_gso: 'No global sign-outs yet.', d_th_initiator: 'Initiator', d_th_scope: 'Scope', d_th_grace: 'Grace', d_th_affected: 'Affected', d_th_reason: 'Reason', d_all_companies: 'All companies',
            fv_close: 'Close', fv_download: 'Download', fv_uploaded_by: 'Uploaded by', fv_loading: 'Loading…', fv_no_preview: 'Preview not available for this file type — download to view.', fv_error: 'Could not open this file.', fv_zoom_in: 'Zoom in', fv_zoom_out: 'Zoom out', fv_zoom_reset: 'Reset zoom', fv_prev: 'Previous', fv_next: 'Next', fv_rotate_left: 'Rotate left', fv_rotate_right: 'Rotate right', fv_flip_h: 'Flip horizontal', fv_flip_v: 'Flip vertical',
            // ---- Pop-up messages (alert/confirm/prompt) — shared error prefixes ----
            err_prefix: 'Error: ', err_could_not_reach: 'Could not reach the server: ',
            // 00-core (deduction rate/pause history)
            a_enter_amount_date: 'Enter both a new weekly amount and an effective date.', a_weekly_neg: 'Weekly amount cannot be negative.', a_rate_change_exists: 'There\'s already a rate change effective {date} for this {label}. Remove the existing one first if you want to replace it.', a_enter_paused_date: 'Enter a paused date.', a_resume_after_paused: 'Expected resume date must be after the paused date.', a_pause_overlaps: 'This overlaps with an existing pause window for this {label}. Remove or adjust the existing one first.', a_no_rate_id: 'Error: could not identify which rate change to delete — try refreshing the page.', c_remove_rate_change: 'Remove this rate change?', a_no_pause_id: 'Error: could not identify which pause to delete — try refreshing the page.', c_remove_pause: 'Remove this pause record?',
            // 10-auth (2FA / sign-out)
            c_cancel_signout: 'Cancel the scheduled sign-out for everyone?', a_2fa_off: 'Two-factor authentication has been turned off.', c_reset_2fa: 'Turn off two-factor authentication for "{user}"?\n\nUse this only if they lost their device. They\'ll be asked to set it up again next time they sign in (if their role requires it).', a_2fa_reset_for: 'Two-factor authentication was reset for "{user}".',
            err_could_not_save: 'Could not save: ', err_saving_claim: 'Error saving claim: ', err_saving_charge: 'Error saving charge: ',
            // 20-employees-claims
            a_pw_updated: 'Password updated successfully.', a_select_company_first: 'Select a specific company first (top-right dropdown) before adding records.', a_company_code_len: 'Company code must be 3 or 4 characters.', a_enter_company_name: 'Enter a company name.', a_copied: 'Copied to clipboard.', c_del_company: 'Delete company {code} and ALL its data (employees, routes, claims, charges, users)? This cannot be undone.', a_print_ios: 'Printing doesn\'t work reliably from the installed app icon — this is a long-standing Safari limitation on iPhone/iPad, not something in Tracker itself.\n\nTo print: open this same page in Safari (not the home screen icon) and print from there.', a_emp_details_missing: 'The employee_details table is not set up yet — the extra ID fields (license, permit, medical card, notes) were not saved. Run the provided SQL setup once, then re-save.', a_no_import_perm: 'You do not have permission to import.', a_csv_empty: 'CSV appears to be empty.', a_csv_cols: 'CSV must include at least "First Name" and "Last Name" columns.', a_import_done: 'Import finished: {ok} added{fail}.', a_import_fail_suffix: ', {n} failed (see console)', c_del_employee: 'Delete employee {id}?', c_gen_login: 'Generate a login for {name}?', a_no_account: 'No account was returned — check the Users tab.', a_select_valid_emp: 'Please select a valid employee from the list.', a_select_emp_first: 'Select an employee first.',
            err_saving_income: 'Error saving income: ', err_save_paytype: 'Could not save pay type: ', err_saving: 'Error saving: ', err_paying_bill: 'Error paying bill {bill}: ',
            // 40-income-provider
            a_income_table_missing: 'The additional_income table is not set up yet. Run the income setup SQL first.', a_select_emp_top: 'Select an employee at the top of the tab first.', a_no_income_id: 'Error: could not identify which income entry to delete — try refreshing the page.', c_del_income: 'Delete income {id}?', a_dailypay_missing: 'Daily-pay tables are not set up yet. See the yellow note in the Daily Pay tab.', c_set_emp_status: 'Set {name} to {status}?', a_tick_bill: 'Tick at least one bill to pay.', c_mark_bills_paid: 'Mark {n} bill(s) as Paid ({amount}) and add that to this week\'s provider pay?', a_no_net_pay: 'No one in the current view has a net amount to pay for this week.',
            err_could_not_send: 'Could not send file: ',
            // 50-messages
            a_pick_person: 'Pick a person first.', a_pick_topic: 'Pick a topic first.', a_pick_date: 'Pick a date for the Missing Day thread.', a_pick_which: 'Pick which {kind} this conversation is about.', a_pick_convo: 'Pick a conversation first (tap +).', c_del_message: 'Delete this message?', a_share_file_hint: 'To share a file, open a Claim, Charge, or Income conversation — the file attaches to that record. (General and Missing Day chats have no record to attach to.)', a_own_files_only: 'You can only share files on your own claims, charges and income.', a_edit_prompt_hint: '\nLeave a value unchanged to keep it. Press Cancel on any field to stop.', a_must_be_number: '"{field}" must be a number. Nothing was saved.', a_release_done: 'Release approved and completed.', c_reject_change: 'Reject this change request?', c_approve_release: 'Approve and execute this release now?', c_reject_release: 'Reject this release request?',
            // 70-financial-init
            a_enter_customer: 'Enter a customer name.', c_del_invoice: 'Delete invoice {id} and all its line items?', a_enter_desc: 'Enter a description.', a_enter_vendor: 'Enter a vendor name.', c_del_bill: 'Delete bill {id}?', c_del_vehicle: 'Delete this vehicle and its whole service log?', a_enter_date_desc: 'Enter both a date and a description.', a_pick_truck: 'Pick a truck.', a_no_export: 'No data to export!',
            err_could_not_upload: 'Could not upload: ', err_importing_file: 'Error importing file: ', err_parsing_file: 'Error parsing file: ', err_importing: 'Error importing: ', err_parsing_sheet: 'Error parsing sheet: ',
            // 30-attach-import-deposit
            p_rename_file: 'Rename file', c_del_file: 'Delete this file? This cannot be undone.', c_del_claim: 'Delete claim {id}?', a_file_empty: 'The file appears to be empty.', a_no_date_cols: 'Could not find any week/date columns starting at column B — check the file format.', a_no_goal_col: 'Could not find the goal amount column (expected a header containing "final" or "goal") after the date columns.', a_no_first_week: 'Could not read the first week\'s date in column B.', a_sheet_empty: 'That sheet appears to be empty.', a_no_7days: 'Could not find 7 day dates in row 2 (columns D–J) of "{sheet}". Make sure this matches the Daily Pay registry format.', a_no_dailypay_rows: 'No importable daily pay rows found in this sheet.', a_no_data_rows: 'No data rows found in the "{sheet}" tab.', a_no_matching_cols: 'Found {n} row(s) in "{sheet}" but none had data in the Employee or Internal RefClaim columns — double-check the sheet has those column headers.', c_del_charge: 'Delete charge {id}?', a_save_emp_first: 'Save this employee first, then edit them to pull from Daily Pay.', a_no_dailypay_emp: 'No Daily Pay entries found for this employee.', c_mark_inactive: 'Mark {name} as Inactive? This locks in today as their departure date (if not already set) and holds their Week in Deposit savings (90 days) and last paycheck (30 days) per the release rules.', a_not_releasable: 'This account can\'t be released yet. Based on this employee\'s Last Date Worked, the earliest eligible date is {date}. Use "Early Release" instead if this needs to happen sooner.', c_no_ldw_90: 'This employee has no Last Date Worked on file, so the 90-day eligibility rule can\'t be checked. Continue anyway?', a_early_release_date: 'This is an EARLY release — the normal eligible date is {date}. {tail}', a_ldw_unknown: 'unknown (no Last Date Worked on file)', a_will_send_admin: 'This will be sent to an Administrator for approval.', a_continue_q: 'Continue?', a_paycheck_released: 'This employee\'s last paycheck has already been released.', a_not_releasable2: 'This can\'t be released yet. Based on this employee\'s Last Date Worked, the earliest eligible date is {date}. Use "Early Release" instead if this needs to happen sooner.', c_no_ldw_30: 'This employee has no Last Date Worked on file, so the 30-day eligibility rule can\'t be checked. Continue anyway?', a_over_committed: 'Uncheck something first — the selected total is more than what\'s available.', a_enter_paycheck: 'Enter the paycheck amount first.', a_sent_approval: 'Sent for Administrator approval — nothing has been released yet. You\'ll see it move once it\'s been acted on.',
            // 60-i18n-sessions (settings / users / bulk-admin / routes)
            a_no_damage_id: 'Error: could not identify which damage type to delete — try refreshing the page.', a_no_chargetype_id: 'Error: could not identify which charge type to delete — try refreshing the page.', a_no_incometype_id: 'Error: could not identify which income type to delete — try refreshing the page.', a_id_settings_updated: 'ID settings updated for future records!', c_change_role: 'Change {user}\'s role from {old} to {new}?', c_signout_session: 'Sign out this session for {who}? They will need to sign in again.', c_signout_others: 'Sign out every other device signed in as you? This device stays signed in.', p_new_password: 'Enter a new password for "{user}":', a_pw_min: 'Password must be at least 8 characters.', a_pw_reset_for: 'Password for "{user}" has been reset.', p_employee_id: 'Employee ID for "{user}" (leave blank to unlink):', c_del_user: 'Are you sure you want to delete user "{user}"?', a_user_deleted: 'User "{user}" deleted successfully.', a_assign_user_emp: 'Please assign this user to an employee.', a_select_company_user: 'Select a specific company first (top-right dropdown) before creating a user.', a_user_created: 'User created successfully!', a_access_denied: 'Access denied. Administrator privileges required.', a_select_company_bulk: 'Select a specific company first (top-right dropdown). Bulk actions apply to one company at a time.', c_del_all_routes: 'Delete ALL route records for company {co}?', a_routes_deleted: 'Routes deleted for {co}.', c_del_all_users: 'WARNING: This deletes ALL user accounts EXCEPT your own. Proceed?', a_all_users_deleted: 'All other users deleted. Your account was kept.', c_del_all_claims: 'Delete ALL claims for company {co}?', a_claims_deleted: 'Claims deleted for {co}.', c_del_all_charges: 'Delete ALL charges for company {co}?', a_charges_deleted: 'Charges deleted for {co}.', c_wipe_company: 'CRITICAL: Wipe ALL operational data (routes, employees, claims, charges) for company {co}, except user accounts. Cannot be undone. Proceed?', a_opdata_reset: 'Operational data reset for {co}.', p_reset_system: 'This removes every user account except Super Admins, and clears the Log and Approvals. Companies and their data are kept.\n\nType RESET SYSTEM to confirm:', a_not_confirmed: 'Not confirmed — nothing was changed.', a_system_reset_done: 'System reset complete. Every non-Super Admin account was removed; the Log and Approvals are cleared. Company data is untouched.', a_select_company_route: 'Please select a Company for this route.', a_tab_empty: 'The \'{sheet}\' tab in the Excel file is empty.', a_routes_imported: 'Successfully imported and synced {n} routes from the \'{sheet}\' tab!', c_del_route: 'Delete this route?',
            // ES-B: computed enum/status DISPLAY values (stored value stays English; only the shown text is localized)
            ev_active: 'Active', ev_inactive: 'Inactive', ev_deducting: 'Deducting', ev_paying: 'Paying', ev_queued: 'Queued', ev_paid: 'Paid', ev_absorbed: 'Absorbed', ev_tk_from_check: 'Tk from check', ev_stopped: 'Stopped', ev_released: 'Released', ev_paused: 'Paused', ev_unpaid: 'Unpaid', ev_void: 'Void', ev_new: 'New', ev_performed: 'Performed', ev_planned: 'Planned', ev_daily: 'Daily', ev_weekly: 'Weekly', ev_provider: 'Provider', ev_employee: 'Employee', ev_staff: 'Staff', ev_contractor: 'Contractor', ev_owner: 'Owner', ev_manager: 'Manager',
            // v3.63: profile photos (optional)
            photo_change: 'Change photo', photo_remove: 'Remove photo', photo_optional: 'Optional — a photo is never required.', c_remove_photo: 'Remove this profile photo?', err_photo_not_image: 'Please choose an image file.', err_photo_save: 'Could not save the photo: ', err_photo_remove: 'Could not remove the photo: ',
            // v3.64: emoji picker
            em_search_ph: 'Search emoji', em_no_recent: 'No recent emojis yet', em_no_match: 'No emojis found',
            // v3.65: condensed account menu
            acct_photo: 'Profile photo', acct_security: 'Security',
            // v3.70 (Tracker 4.0 P3): hub navigation
            hub_home: 'Home', hub_operations: 'Operations', hub_people: 'People', hub_payroll: 'Payroll', hub_finance: 'Finance', hub_documents: 'Documents', hub_messages: 'Messages', hub_admin: 'Admin', hub_more: 'More', tab_overview: 'Overview',
            // v3.71 (Tracker 4.0 P4): mission-control home
            greet_morning: 'Good morning', greet_afternoon: 'Good afternoon', greet_evening: 'Good evening',
            attn_review: 'Review', attn_paychecks: 'Paycheck decisions', attn_msgs: 'Unread messages',
            qa_new_claim: 'New claim', qa_add_person: 'Add person', qa_new_invoice: 'New invoice',
            // v3.72 (Tracker 4.0 final): full mission-control home
            home_needs_attention: 'Here\'s what needs your attention.', qa_upload_doc: 'Upload document',
            attn_approvals: 'Approvals pending', attn_capt_approvals: 'Releases waiting on you',
            attn_capt_paychecks: 'Last-paycheck holds', attn_capt_expiring: 'Within the next 30 days',
            attn_capt_msgs: 'In your conversations', attn_capt_notifs: 'Since you last checked',
            hp_title: 'This week\'s payroll', hp_open: 'Open payroll', hp_net: 'Net to pay', hp_week: 'Week', hp_inprog: 'in progress',
            ra_title: 'Recent activity', ra_viewall: 'View all', ra_today: 'Today', ra_events: 'events'
        },
        es: {
            welcome_prefix: 'Bienvenido,', role_label: 'Rol:', company_label: 'Compañía:',
            synchronized: 'Sincronizado', change_password_btn: 'Cambiar Contraseña', sign_out_btn: 'Cerrar Sesión',
            change_password_title: 'Cambiar Mi Contraseña', current_password: 'Contraseña Actual',
            new_password: 'Nueva Contraseña', confirm_new_password: 'Confirmar Nueva Contraseña',
            save_password: 'Guardar Contraseña', cancel: 'Cancelar',
            group_logistics: 'Logística', group_hr: 'RR. HH. y Nómina', group_admin: 'Administración',
            tab_tracker: 'Rastreador de Rutas', tab_report: 'Informe Diario', tab_vehicles: 'Flota',
            tab_notifications: 'Notificaciones', tab_employees: 'Empleados', tab_claims: 'Reclamos y Cargos',
            tab_charges: 'Cargos e Ingresos', tab_income: 'Ingresos', tab_dailypay: 'Pago Diario', tab_statement: 'Estado de Cuenta',
            tab_payroll: 'Nómina', tab_settings: 'Configuración', tab_users: 'Usuarios', tab_companies: 'Compañías',
            tab_approvals: 'Aprobaciones', tab_log: 'Registro', tab_data: 'Sincronización de Datos', tab_changelog: 'Historial de Cambios',
            login_title: 'Iniciar Sesión', username_label: 'Usuario', username_ph: 'Ingrese su usuario',
            password_label: 'Contraseña', sign_in_btn: 'Iniciar Sesión',
            timeout_notice: 'Se cerró su sesión después de 5 minutos de inactividad.',
            language_label: 'Idioma',
            language_note: 'Elija su idioma. Esto se guarda solo en este dispositivo, así que otras personas conectadas en otro lugar mantienen su propia preferencia. (También disponible en la pantalla de inicio de sesión.)',
            appearance_label: 'Apariencia',
            clear_filters: '✕ Limpiar filtros', sort_by: 'Ordenar por',
            new_contact: 'Nuevo Contacto', next_id: 'Próximo ID', basic_info: 'Información básica',
            first_name: 'Nombre', last_name: 'Apellido', person_type: 'Tipo de Persona',
            department: 'Departamento', role_title: 'Puesto / Cargo', start_date: 'Fecha de Inicio',
            contact_info: 'Información de contacto', phone: 'Teléfono', email: 'Correo electrónico',
            identification: 'Identificación', ssn_itin: 'SSN o ITIN #', type_label: 'Tipo',
            dl_or_state_id: 'Licencia de Conducir o ID Estatal #', dl_expiration: 'Vencimiento de Licencia/ID Estatal',
            work_permit: 'Permiso de Trabajo #', work_permit_exp: 'Vencimiento del Permiso de Trabajo',
            medical_card: 'Tarjeta Médica', medical_card_exp: 'Vencimiento de Tarjeta Médica', notes: 'Notas',
            pay: 'Pago', pay_type: 'Tipo de Pago', base_weekly_pay: 'Pago Semanal Base ($)',
            employee_note: 'Elija <strong>Pago Diario</strong> para cualquier persona cuyo pago cambie semana a semana — ingrese sus montos día a día en la pestaña <strong>Pago Diario</strong>. Al editar, deje <strong>SSN/ITIN</strong> en blanco para mantener el número guardado sin cambios. La licencia de conducir, el permiso de trabajo, la tarjeta médica y las notas se muestran abiertamente en el directorio; el SSN/ITIN permanece oculto.',
            add_employee: 'Agregar Empleado', cancel_edit: 'Cancelar edición',
            search_employees_ph: 'Buscar nombre, ID, departamento, tipo...',
            export_csv: 'Exportar CSV', import_csv: 'Importar CSV',
            th_id: 'ID', th_name: 'Nombre', th_type: 'Tipo', th_department: 'Departamento',
            th_start: 'Inicio', th_pay: 'Pago', th_status: 'Estado', th_action: 'Acción',
            new_claim: 'Nuevo Reclamo', next_claim_id: 'Próximo ID de Reclamo', claimant_account: 'Cuenta del reclamante',
            company_field: 'Compañía', employee_field: 'Empleado', carrier_claim_num: 'N.º de reclamo del transportista',
            customer_claim_num: 'N.º de reclamo del cliente', type_of_damage: 'Tipo de daño', claim_amount: 'Monto del reclamo',
            weekly_deduction: 'Deducción semanal', start_deduction_date: 'Fecha de inicio de deducción',
            end_deduction_date: 'Fecha de fin de deducción', status_field: 'Estado', absorbed_amount: 'Monto absorbido',
            weeks_needed_note: 'Semanas necesarias = monto del reclamo ÷ deducción semanal (redondeado hacia arriba), calculado automáticamente.',
            save_claim: 'Guardar Reclamo', weekly_deduction_rate: 'Tasa de deducción semanal',
            new_weekly_amount: 'Nuevo monto semanal', effective_date: 'Fecha de vigencia', add_rate_change: 'Agregar cambio de tasa',
            pause_resume: 'Pausar / Reanudar', paused_date: 'Fecha de pausa', expected_resume: 'Reanudación esperada (opcional)',
            record_pause: 'Registrar pausa', search_claims_ph: 'Buscar ID de Reclamo, Empleado, cuenta, compañía...',
            import_excel_csv: 'Importar Excel/CSV',
            th_claim_id: 'ID de Reclamo', th_employee: 'Empleado', th_emp_id: 'ID Empleado', th_claimant_acct: 'Cuenta Reclamante',
            th_company: 'Compañía', th_carrier: 'N.º Transportista', th_customer: 'N.º Cliente', th_damage_type: 'Tipo de Daño',
            th_amount: 'Monto', th_weeks: 'Semanas', th_balance: 'Saldo', th_absorbed: 'Absorbido', th_ends: 'Finaliza',
            employee_applies_both: 'Empleado <span style="color:var(--text-muted); font-weight:400;">— para el nuevo cargo abajo</span>',
            new_charge: 'Nuevo Cargo', next_charge_id: 'Próximo ID de Cargo', charge_type: 'Tipo de cargo', charge_amount: 'Monto del cargo',
            save_charge: 'Guardar Cargo', search_charges_ph: 'Buscar ID de cargo, empleado, tipo, estado...',
            new_additional_income: 'Nuevo Ingreso Adicional', next_income_id: 'Próximo ID de Ingreso', income_type: 'Tipo de ingreso',
            total_amount: 'Monto total', weekly_amount: 'Monto semanal', end_date: 'Fecha de fin',
            income_note: 'El ingreso adicional se <strong>suma</strong> al pago del empleado cada semana (lo opuesto a un cargo) — el monto semanal se paga hasta alcanzar el total, y luego se detiene automáticamente.',
            save_income: 'Guardar Ingreso', search_income_ph: 'Buscar ID de ingreso, empleado, tipo, estado...',
            th_charge_id: 'ID de Cargo', th_income_id: 'ID de Ingreso', th_type: 'Tipo', th_weekly: 'Semanal', th_remaining: 'Restante',
            // --- R1: shell, login 2FA step, overlays ---
            twofa_menu: 'Autenticación de Dos Factores', signout_other_devices: 'Cerrar sesión en mis otros dispositivos',
            two_step_title: 'Verificación en dos pasos',
            two_step_help: 'Ingrese el código de 6 dígitos de su app de autenticación. También puede usar uno de sus códigos de recuperación.',
            verify_btn: 'Verificar', back_to_signin: '← Volver a iniciar sesión',
            twofa_setup_title: 'Configurar la autenticación de dos factores',
            twofa_step1: '1. Agregue esta cuenta a una app de autenticación',
            twofa_apps_note: 'Use Google Authenticator, Microsoft Authenticator, Authy, 1Password o cualquier app TOTP.',
            twofa_open_app: '📲 Abrir en la app de autenticación', twofa_manual_key: 'O ingrese esta clave manualmente:',
            copy_btn: 'Copiar', twofa_step2_label: '2. Ingrese el código de 6 dígitos que muestra',
            twofa_verify_on: 'Verificar y activar', try_again_btn: 'Intentar de nuevo', skip_for_now: 'Omitir por ahora',
            twofa_is_on: '✅ La autenticación de dos factores está activada', twofa_save_recovery: 'Guarde sus códigos de recuperación',
            twofa_recovery_help: 'Cada código funciona una sola vez. Si pierde su teléfono, un código de recuperación le permite iniciar sesión. Guárdelos en un lugar seguro: solo se muestran ahora.',
            twofa_copy_codes: 'Copiar códigos', twofa_saved_ack: 'He guardado estos códigos de recuperación', done_btn: 'Listo',
            twofa_intro_mandatory: 'Su rol recomienda la autenticación de dos factores. Configúrela ahora u omítala: le recordaremos de nuevo en 15 días.',
            twofa_intro_optional: 'Agregue un segundo paso al iniciar sesión para mayor seguridad.',
            unusual_activity_title: 'Actividad de inicio de sesión inusual', gso_cancel_admin: 'Cancelar (admin)',
            gso_title: '🚪 Cerrar sesión a todos los usuarios', gso_everyone_pre: 'Todos',
            gso_everyone_post: 'recibirán un aviso con cuenta regresiva y luego se cerrará su sesión en todos los dispositivos. Su trabajo sin guardar se perderá.',
            gso_grace_period: 'Período de gracia', mins_5: '5 minutos', mins_10: '10 minutos', mins_15: '15 minutos',
            mins_2: '2 minutos', mins_1: '1 minuto', gso_reason_label: 'Motivo (opcional — visible para todos)',
            gso_reason_ph: 'p. ej. mantenimiento del sistema', gso_type_pre: 'Escriba', gso_type_post: 'para confirmar',
            gso_start: 'Iniciar cierre de sesión', gso_scope_all: 'en todas las compañías', gso_scope_company: 'en su compañía',
            idle_title: '¿Sigue ahí?', idle_pre: 'Se cerrará su sesión en',
            idle_post: 's por inactividad. Cualquier cambio sin guardar podría perderse.', idle_stay: 'Seguir conectado',
            // --- R2: Settings, Home, Notifications ---
            id_config: 'Configuración de ID',
            id_config_note: 'Los cambios aquí solo afectan a los <strong>nuevos</strong> ID en adelante — los ID de empleado, reclamo y cargo ya asignados no cambiarán. El <strong>prefijo del ID es el código de la compañía</strong> (definido al agregar una compañía), así que cambie de compañía arriba para controlarlo.',
            emp_id_digits: 'Dígitos del ID de empleado', claim_id_digits: 'Dígitos del ID de reclamo', charge_id_digits: 'Dígitos del ID de cargo',
            charge_id_suffix: 'Sufijo del ID de cargo', save_id_format: 'Guardar formato de ID',
            damage_type_panel: 'Tipo de daño (Reclamos)', add_damage_type: 'Agregar un nuevo tipo de daño', damage_type_ph: 'p. ej. Daño por agua',
            add_btn: 'Agregar', charge_type_panel: 'Tipo de cargo (Cargos)', add_charge_type: 'Agregar un nuevo tipo de cargo', charge_type_ph: 'p. ej. Adelanto',
            th_charge_type: 'Tipo de cargo', income_type_panel: 'Tipo de ingreso adicional', add_income_type: 'Agregar un nuevo tipo de ingreso',
            income_type_ph: 'p. ej. Bono', th_income_type: 'Tipo de ingreso',
            home_subtitle: 'Así están las cosas ahora mismo.',
            notif_note: 'Los reclamos, cargos e ingresos adicionales que se le asignen aparecen aquí. Toque uno para ir directo a él. Las cuentas de Solo Lectura solo ven los suyos; los demás ven los de toda su compañía, igual que en el resto de la app.',
            date_range: 'Rango de fechas', range_all: 'Todo el tiempo', range_30: 'Últimos 30 días', range_60: 'Últimos 60 días',
            range_90: 'Últimos 90 días', range_365: 'Último año', sort_short: 'Ordenar', opt_date: 'Fecha', mark_all_read: 'Marcar todo como leído',
            // --- R3: Logistics (Tracker, Report, Fleet, Expiring) ---
            log_new_route: 'Registrar nueva ruta', delivery_date: 'Fecha de entrega', route_type: 'Tipo de ruta', third_man: '3er hombre',
            driver: 'Conductor', route_num: 'N.º de ruta', route_id: 'ID de ruta', miles: 'Millas', manifest_stops: 'Paradas del manifiesto',
            pullbacks: 'Devoluciones', incompletes: 'Incompletas', dedicated_flat_pay: 'Pago fijo dedicado', deductions: 'Deducciones',
            extra_pay: 'Pago extra', add_route: 'Agregar ruta', th_regded: 'Reg/Ded', th_loaded: 'Paradas cargadas',
            th_completed: 'Paradas completadas', th_mileage_pay: 'Pago por millaje', th_fuel_pay: 'Pago de combustible', th_total_daily: 'Pago diario total',
            th_total_route: 'Pago total por ruta',
            year_label: 'Año', week_label: 'Semana', expand_all: '➕ Expandir todo', collapse_all: '➖ Contraer todo', row_labels: 'Etiquetas de fila',
            th_delivery_area: 'Área de entrega*', th_miles2: 'Millas**', th_manifest2: 'Paradas del manifiesto**', th_pullbacks2: 'Devoluciones**',
            th_loaded2: 'Paradas cargadas*', th_incompletes2: 'Incompletas*', th_completed2: 'Paradas completadas*', th_mileage2: 'Pago por millaje*',
            th_fuel2: 'Pago de combustible**', th_thirdman2: '3er hombre**', th_dedicated_flat: 'Fijo dedicado*', th_deductions2: 'Deducciones*',
            th_extra2: 'Pago extra*', th_total_route2: 'Pago total por ruta*',
            add_vehicle_title: 'Agregar vehículo', truck_num: 'N.º de camión', truck_num_ph: 'N.º ID de la compañía', make: 'Marca', make_ph: 'p. ej. Freightliner',
            model: 'Modelo', model_ph: 'p. ej. Cascadia', license_plate: 'Placa', reg_expiry: 'Vencimiento de registro',
            ins_company: 'Compañía de seguro', policy_number: 'Número de póliza', ins_expiry: 'Vencimiento del seguro', add_vehicle_btn: 'Agregar vehículo',
            sched_maint: '📅 Programar mantenimiento', truck: 'Camión', date_label: 'Fecha', description: 'Descripción',
            sched_desc_ph: 'p. ej. Cambio de aceite, Inspección DOT', schedule_btn: '+ Programar',
            vehicle_search_ph: 'Buscar n.º de camión, año, marca, modelo, placa, VIN...', export_btn: '⬇️ Exportar', import_btn: '⬆️ Importar',
            opt_vehicle: 'Vehículo', opt_plate: 'Placa', opt_reg_exp: 'Venc. de registro',
            expiring_title: 'Documentos por vencer',
            expiring_note: 'Registro y seguro de la Flota, más licencia de conducir, permiso de trabajo y tarjeta médica de Empleados — todo en un solo lugar, lo más próximo primero. Los ya vencidos aparecen arriba.',
            show_within: 'Mostrar dentro de', days_30: '30 días', days_60: '60 días', days_90: '90 días', year_1: '1 año',
            everything_on_file: 'Todo en el archivo', category: 'Categoría', all_categories: 'Todas las categorías', fleet_only: 'Solo Flota',
            emp_docs_only: 'Solo documentos de empleados', expiring_search_ph: 'Buscar nombre, n.º de camión...',
            // --- R3b: HR/Payroll ---
            all_types: 'Todos los tipos', contractor: 'Contratista', opt_employee: 'Empleado', opt_provider: 'Proveedor', opt_staff: 'Personal',
            active_opt: 'Activo', inactive_opt: 'Inactivo', all_statuses: 'Todos los estados', active_only: 'Solo activos',
            search_name_id_ph: 'Buscar nombre o ID...', prev_btn: '◀ Ant.', next_btn: 'Sig. ▶', this_week: 'Esta semana',
            print_btn: '🖨 Imprimir', saved_flash: 'Guardado ✓', select_employee_opt: '— Seleccionar empleado —',
            optional_ph: 'opcional', save_changes: '💾 Guardar cambios',
            dailypay_title: 'Hoja de pago diario', import_registry: 'Importar registro',
            dailypay_note: 'Ingrese el pago de cada persona por los días que trabajó (dom–sáb). Toque <strong>OFF</strong> para los días libres — esos se omiten del total semanal. Las entradas se guardan automáticamente y se conservan por semana, así que puede consultar cualquier semana pasada con las flechas. Aquí solo aparecen las personas con <strong>Tarifa diaria</strong> (cambie el tipo de pago de una persona en la pestaña Empleados).',
            weekdeposit_note: 'Estos se leen de los cargos de <strong>Semana de Fondo</strong> ya registrados en la pestaña Cargos e Ingresos — una meta de ahorro, acumulada semana a semana. Esta vista no crea nuevos; agregue un nuevo depósito igual que cualquier otro cargo, usando "Semana de Fondo" como tipo de cargo.',
            edit_deposit: 'Editar depósito', savings_goal: 'Meta de ahorro ($)', weekly_saving: 'Ahorro semanal ($)',
            deducting_opt: 'Deduciendo', paid_opt: 'Pagado', absorbed_opt: 'Absorbido',
            summary_report_excel: '📊 Reporte resumen (Excel)', summary_report_pdf: '📊 Reporte resumen (PDF)',
            providerpay_title: 'Pago a proveedores',
            providerpay_note: 'Ingrese el pago de cada proveedor por la semana — un solo monto, ya que los proveedores no tienen tarifa fija. Se guarda automáticamente y se conserva por semana, así que puede consultar cualquier semana pasada con las flechas. Aquí solo aparecen las personas con tipo de pago <strong>Proveedor</strong> (cambie el tipo de pago de una persona en la pestaña Empleados). Alimenta la Nómina igual que el Pago diario. <strong>Vinculado a Cuentas por pagar:</strong> cualquier factura sin pagar cuyo proveedor coincida con el nombre de un proveedor aparece bajo ese proveedor — marque una o más y toque “Pagar seleccionadas” para marcar esas facturas como Pagadas y sumar su total al monto de esta semana.',
            payroll_title: 'Resumen de nómina', print_all: '🖨 Imprimir todo',
            payroll_note: 'Pago neto = pago base + pago por rutas (conductores) + ingreso adicional − deducciones semanales activas (reclamos + cargos que se están deduciendo actualmente). El pago base es el <strong>salario semanal</strong> fijo para las personas Semanales, o el total del <strong>Pago diario</strong> de esta semana para las personas con tarifa diaria. El pago por rutas, el ingreso adicional y el pago diario usan la semana actual.',
            savings_release_title: 'Ahorros y elegibilidad de liberación',
            savingsrelease_note: 'Los cheques se emiten los jueves y se entregan los sábados. La Semana de Fondo no puede liberarse antes de <strong>90 días</strong> después de la última fecha trabajada de un empleado; el pago de la última semana trabajada de ese mismo empleado no puede liberarse antes de <strong>30 días</strong> después de esa fecha. "Pendiente" incluye cualquier reclamo o cargo — de cualquier estado — con saldo real, o (solo reclamos) un monto absorbido restante.',
            search_employee_ph: 'Buscar empleado...', week_in_deposit_opt: 'Semana de Fondo', last_paycheck_opt: 'Último cheque',
            all_eligibility: 'Toda elegibilidad', ready_release_now: 'Listo para liberar ahora', not_yet_eligible: 'Aún no elegible',
            release_history_title: 'Historial de liberaciones',
            releasehistory_note: 'Registro permanente de cada liberación de Semana de Fondo y Último Cheque — monto original, lo que se dedujo hacia otros reclamos/cargos, y lo que realmente recibió el empleado.',
            search_emp_releasedby_ph: 'Buscar empleado, liberado por...',
            early_ontime: 'Anticipadas y a tiempo', early_only: 'Solo anticipadas', ontime_only: 'Solo a tiempo',
            // --- R4: Messages, Invoices, Bills, Users, Companies, Approvals, Log, Data Sync, Changelog ---
            dm_search_ph: 'Buscar conversaciones...', pill_all: 'Todas', pill_general: 'General', pill_missing_day: 'Día faltante',
            pill_claims: 'Reclamos', pill_charges: 'Cargos', pill_income: 'Ingresos', dm_compose_ph: 'Escriba un mensaje...',
            dm_empty_state: 'Seleccione una persona a la izquierda para iniciar una conversación.',
            new_invoice_title: 'Nueva factura', edit_invoice_title: 'Editar factura', save_invoice_btn: 'Guardar factura', update_invoice_btn: 'Actualizar factura',
            inv_number: 'Factura n.º', inv_customer: 'Cliente', inv_date: 'Fecha de factura', due_date: 'Fecha de vencimiento', bill_to: 'Facturar a',
            unpaid_opt: 'Sin pagar', void_opt: 'Anulada',
            inv_number_ph: 'p. ej. 0169', inv_customer_ph: 'p. ej. Tramo', inv_billto_ph: 'Compañía, dirección, contacto — como aparece en la factura',
            line_items: 'Conceptos', add_line: 'Agregar línea',
            invoice_search_ph: 'Buscar factura n.º, cliente, notas...', all_customers: 'Todos los clientes',
            new_bill_title: 'Nueva cuenta', edit_bill_title: 'Editar cuenta', save_bill_btn: 'Guardar cuenta', update_bill_btn: 'Actualizar cuenta',
            vendor: 'Proveedor', vendor_bill_num: 'N.º de cuenta del proveedor', bill_date: 'Fecha de la cuenta', amount_label: 'Monto',
            bill_vendor_ph: 'p. ej. ABC Fuel Co, o elija un proveedor', bill_number_ph: 'p. ej. INV-9001',
            bill_search_ph: 'Buscar proveedor, cuenta n.º, notas...', all_vendors: 'Todos los proveedores',
            create_user_title: 'Crear nuevo perfil de usuario', role_field: 'Rol', assign_employee: 'Asignar a empleado',
            create_user_btn: 'Crear usuario', system_users: 'Usuarios del sistema', refresh_btn: 'Actualizar',
            active_sessions: 'Sesiones activas', session_signout_note: 'Cerrar una sesión surte efecto de inmediato.',
            failed_signins: 'Inicios de sesión fallidos recientes',
            failed_signins_note: 'Últimos 7 días. Una cuenta se bloquea 5 minutos tras 5 fallos; una red se bloquea 15 minutos tras 30.',
            gso_history: 'Historial de cierre de sesión global',
            gso_history_note: 'Cada acción de \'Cerrar sesión de todos\': quién la inició, cuándo, por qué y a cuántos afectó.',
            add_company_title: 'Agregar compañía', add_company_btn: 'Agregar compañía', save_changes_plain: 'Guardar cambios', editing_prefix: 'Editando',
            company_section: 'Compañía', company_code: 'Código de compañía (3–4 caracteres)', company_name: 'Nombre de la compañía',
            ownership_contact: 'Propiedad y contacto', owner_label: 'Propietario', manager_label: 'Gerente', manager_phone: 'Teléfono del gerente',
            company_code_ph: 'p. ej. 3FL', company_name_ph: 'p. ej. 3 Of Life LLC', owner_ph: 'Nombre del propietario', phone_ph: '(555) 555-5555',
            email_ph: 'nombre@ejemplo.com', manager_ph: 'Nombre del gerente', companies_title: 'Compañías',
            pending_approvals: 'Aprobaciones pendientes',
            approvals_note: 'Los cambios financieros bloqueados (tarifa de pago base, monto del reclamo, deducción semanal) solicitados por usuarios Medium aparecen aquí para la aprobación del Administrador.',
            pending_release_requests: 'Solicitudes de liberación pendientes',
            release_requests_note: 'La liberación de Semana de Fondo o Último Cheque de un usuario Medium — normal o anticipada — siempre llega aquí primero. Nada se libera hasta que un Administrador lo apruebe.',
            change_log_title: 'Registro de cambios',
            log_note: 'Cada cambio aplicado a empleados, reclamos, cargos y rutas se registra aquí.',
            export_data_title: 'Exportar datos', download_excel_backup: '⬇️ Descargar respaldo Excel (solo Rastreador de rutas)',
            export_all_data: '⬇️ Exportar todos los datos (un solo archivo)',
            export_all_note: 'Un archivo .xlsx con una hoja separada para Empleados, Reclamos, Cargos, Ingresos adicionales, Vehículos, Rutas, Pago diario y Pago a proveedores — todo a lo que tiene acceso, en una sola descarga. El SSN/ITIN del empleado nunca se incluye en ninguna exportación.',
            import_all_title: 'Importar todos los datos (un solo archivo)',
            import_all_note: 'Suba un archivo exportado desde <strong>Exportar todos los datos</strong> arriba (o editado a mano para coincidir con su diseño de columnas) para restaurar Reclamos, Cargos, Ingresos adicionales, Vehículos, Rutas, Pago diario y Pago a proveedores en un solo paso — vinculados a los empleados existentes por ID de empleado. No toca a los Empleados en sí; use Importar CSV en la pestaña Empleados para eso.',
            import_sync_routes_title: 'Importar y sincronizar rutas desde Excel (Pestaña: Rastreador)',
            admin_danger_title: 'Zona de gestión y restablecimiento del Administrador',
            admin_danger_note: 'Estas acciones están restringidas solo a usuarios <strong>Administrador</strong>.',
            del_all_routes: '🗑️ Eliminar todas las rutas', del_all_claims: '🗑️ Eliminar todos los reclamos', del_all_charges: '🗑️ Eliminar todos los cargos',
            del_all_users: '🗑️ Eliminar todos los usuarios', reset_all_except_users: '⚠️ Restablecer todos los datos (excepto usuarios)',
            gso_signout_note: 'Da a todos una advertencia con cuenta regresiva y luego los cierra en todos los dispositivos. Los Administradores afectan su propia compañía; el Súper Admin afecta a todos.',
            sysreset_title: 'Restablecimiento del sistema — Solo Súper Admin',
            sysreset_note: 'Elimina todas las cuentas de usuario excepto los Súper Admin, y borra el Registro de auditoría y las Aprobaciones pendientes. Las compañías y todo lo que les pertenece — empleados, reclamos, cargos, rutas, ingresos — <strong>no</strong> se tocan. No se puede deshacer.',
            reset_system_btn: '☢️ Restablecer sistema (conservar compañías y Súper Admin)',
            changelog_title: 'Registro de cambios',
            changelog_note: 'Cada cambio entregado a esta app, más reciente primero — almacenado en el servidor para que este historial sobreviva incluso a cambios del archivo de la app. Solo visible para el Súper Admin.',
            search_results_title: 'Resultados de búsqueda',
            // --- R4b: record-grid sort-dropdown options ---
            sort_kind: 'Clase', sort_start_ded: 'Inicio ded.', sort_start: 'Inicio', sort_base: 'Base (sem)',
            sort_gross: 'Bruto', sort_net: 'Neto', sort_bill_num: 'Cuenta n.º', sort_employee_id: 'ID de empleado',
            sort_created: 'Creado', sort_code: 'Código', sort_requested: 'Solicitado', sort_requested_by: 'Solicitado por',
            sort_table: 'Tabla', sort_field: 'Campo', sort_when: 'Cuándo', sort_who: 'Quién',
            // --- R5a: dynamic card chrome — Employees & Fleet ---
            d_type: 'Tipo', d_department: 'Departamento', d_start_date: 'Fecha de inicio', d_pay: 'Pago', d_status: 'Estado',
            d_edit: 'Editar', d_delete: '✕ Eliminar', d_phone: 'Teléfono', d_email: 'Correo', d_ssn_itin: 'SSN / ITIN',
            d_dl_stateid: 'Licencia de conducir / ID estatal', d_dl_exp: 'Vencimiento de licencia', d_wp_num: 'Permiso de trabajo n.º', d_wp_exp: 'Vencimiento del permiso de trabajo',
            d_medcard: 'Tarjeta médica', d_medcard_exp: 'Vencimiento de tarjeta médica', d_role_title: 'Rol / Cargo', d_notes: 'Notas',
            d_status_history: 'Historial de estado', d_generate_user: 'Generar usuario', d_loading: 'Cargando…',
            d_no_status_changes: 'Aún no hay cambios de estado registrados.', d_th_date: 'Fecha', d_th_change: 'Cambio', d_th_by: 'Por',
            d_no_employees: 'No se encontraron empleados.', d_no_vehicles: 'Aún no hay vehículos.', d_nothing_expiring: 'Nada por vencer en este período.',
            d_no_upcoming_maint: 'No hay mantenimiento programado próximo.', d_no_service_records: 'Aún no hay registros de servicio.',
            d_already_expired: 'Ya vencidos', d_within_14: 'Dentro de 14 días', d_total_shown: 'Total mostrado',
            d_edit_vehicle_record: '✎ Editar registro de vehículo', d_edit_employee_record: '✎ Editar registro de empleado',
            d_stat_fleet: 'Flota', d_stat_reg_exp: 'Registro por vencer/vencido', d_stat_ins_exp: 'Seguro por vencer/vencido',
            d_th_id: 'ID', d_th_truck: 'Camión n.º', d_th_vehicle: 'Vehículo', d_th_plate: 'Placa', d_th_reg_exp: 'Venc. de registro',
            d_th_ins_co: 'Cía. de seguro', d_th_ins_exp: 'Venc. del seguro',
            d_reg_expiry: 'Vencimiento de registro', d_insurance_company: 'Compañía de seguro', d_policy_num: 'Póliza n.º', d_insurance_expiry: 'Vencimiento del seguro',
            d_license_plate: 'Placa', d_vin: 'VIN', d_service_log: 'Registro de servicio', d_mileage_at_service: 'Millaje al servicio',
            d_next_service_due: 'Próximo servicio a las', d_add: '+ Agregar', d_service_desc_ph: 'p. ej. Cambio de aceite, Rotación de llantas',
            // --- R5a: dynamic card chrome — Claims, Charges, Income ---
            d_no_cc: 'No se encontraron reclamos ni cargos.', d_th_kind: 'Clase', d_employee: 'Empleado', d_employee_id: 'ID de empleado',
            d_claimant_acct: 'Cuenta del reclamante', d_company: 'Compañía', d_carrier_claim: 'N.º de reclamo del transportista', d_customer_claim: 'N.º de reclamo del cliente',
            d_type_damage: 'Tipo de daño', d_claim_amount: 'Monto del reclamo', d_weeks: 'Semanas', d_balance: 'Saldo', d_absorbed: 'Absorbido',
            d_start_ded: 'Inicio ded.', d_end_ded: 'Fin ded.', d_edit_full: '✎ Editar',
            d_charge_type: 'Tipo de cargo', d_amount: 'Monto', d_weekly_deduction: 'Deducción semanal',
            d_income_type: 'Tipo de ingreso', d_weekly_amount: 'Monto semanal', d_start: 'Inicio', d_ends: 'Termina',
            d_no_income: 'No se encontraron ingresos adicionales.',
            d_income_setup_note: 'Ejecute el SQL de configuración de ingresos (la tabla <strong>additional_income</strong>) para empezar a registrar ingresos adicionales.',
            d_th_effective: 'Vigente', d_th_weekly: 'Semanal', d_no_rate_changes: 'Sin cambios de tarifa — usando el monto semanal base.',
            d_th_paused: 'Pausado', d_th_resume: 'Reanudar', d_no_pauses: 'Aún no hay pausas registradas.',
            // --- R5a: dynamic card chrome — Payroll ---
            d_no_people_match: 'Nadie coincide con estos filtros.', d_th_name: 'Nombre',
            d_base_wk: 'Base (sem)', d_route_wk: 'Ruta (sem)', d_income_wk: 'Ingreso (sem)', d_gross: 'Bruto', d_deductions_h: 'Deducciones', d_net: 'Neto',
            d_base_pay_wk: 'Pago base (sem)', d_route_pay_wk: 'Pago por ruta (sem)', d_weekly_deductions: 'Deducciones semanales', d_net_pay: 'Pago neto',
            d_people: 'Personas', d_gross_wk: 'Bruto (sem)', d_deductions_wk: 'Deducciones (sem)', d_net_pay_wk: 'Pago neto (sem)',
            d_th_day: 'Día', d_th_pay: 'Pago', d_base_daily_total: 'Base (total diario)', d_provider_pay: 'Pago a proveedor', d_weekly_salary: 'Salario semanal',
            d_route_pay_dot: 'Pago por ruta', d_th_route: 'Ruta', d_route_total: 'Total de ruta',
            d_no_daily_pay: 'Sin pago diario ingresado para', d_no_provider_pay: 'Sin pago a proveedor ingresado para',
            d_additional_income: 'Ingreso adicional', d_income_total: 'Total de ingresos', d_total_deductions: 'Total de deducciones', d_no_active_ded: 'Sin deducciones semanales activas.',
            d_print_payslip: '🖨 Imprimir recibo', d_paid_days_base: 'Días pagados / pago base',
            // --- R5a: dynamic card chrome — Statement, Week Deposit, Savings/Release, Release History, Pay ---
            d_stat_claims: 'Reclamos', d_stat_charges: 'Cargos', d_stat_add_income: 'Ingreso adicional',
            d_total_claims: 'Total de reclamos', d_total_charges: 'Total de cargos', d_total_income: 'Total de ingresos',
            d_select_emp_stmt: 'Seleccione un empleado arriba para ver su estado de cuenta.', d_current_deductions: 'Deducciones actuales — desglose completo',
            d_no_current_cc: 'Sin reclamos ni cargos actuales para este empleado.', d_add_income_breakdown: 'Ingreso adicional — desglose completo',
            d_claimant_account: 'Cuenta del reclamante', d_weekly_rate: 'Tarifa semanal', d_weeks_to_zero: 'Semanas hasta $0', d_paid_so_far: 'Pagado hasta ahora',
            d_print_schedule: '🖨 Imprimir cronograma', d_th_deducted: 'Deducido', d_th_running_balance: 'Saldo acumulado',
            d_no_schedule_claim: 'Sin cronograma que proyectar — el reclamo está resuelto o necesita una fecha de inicio y un monto semanal.',
            d_no_schedule_charge: 'Sin cronograma que proyectar — el cargo está resuelto o necesita una fecha de inicio y un monto semanal.',
            d_weekly: 'Semanal', d_remaining: 'Restante',
            d_goal: 'Meta', d_weekly_saving: 'Ahorro semanal', d_saved_so_far: 'Ahorrado hasta ahora', d_remaining_to_goal: 'Falta para la meta',
            d_of_goal: 'de la meta', d_release: '🔓 Liberar', d_early_release: '⏰ Liberación anticipada', d_th_saved_week: 'Ahorrado esa semana',
            d_total_saved: 'Total ahorrado', d_active_deposits: 'Depósitos activos', d_total_remaining: 'Total restante', d_no_deposits: 'No se encontraron depósitos.',
            d_ready_now: 'Listo para liberar ahora', d_total_tracked: 'Total en seguimiento', d_wid_savings: 'Ahorros de Semana de Fondo',
            d_nothing_savings: 'Nada que mostrar — no hay ahorros de Semana de Fondo abiertos ni empleados Inactivos con un último cheque sin liberar (según los filtros actuales).',
            d_pending_elsewhere: 'Pendiente en otro lugar', d_eligible_date: 'Fecha de elegibilidad', d_check_issued: 'Cheque emitido (jue)',
            d_handed_over: 'Entregado (sáb)', d_not_eligible_until: 'No elegible hasta',
            d_total_releases: 'Total de liberaciones', d_net_released_emp: 'Neto liberado a empleados', d_total_applied_ded: 'Total aplicado a deducciones',
            d_early_releases: 'Liberaciones anticipadas', d_no_releases: 'Aún no hay liberaciones registradas (según los filtros actuales).',
            d_base_pay: 'Pago base', d_additional_income_c: 'Ingreso adicional', d_original_amount: 'Monto original',
            d_total_deductions_c: 'Total de deducciones', d_final_released: 'Monto final liberado', d_requested_via: '¿Solicitado por aprobación?',
            d_applied_to: 'Aplicado a', d_no_other_outstanding: 'Sin otros reclamos o cargos pendientes al momento de la liberación.', d_by: 'por',
            d_no_pending_release: 'No hay solicitudes de liberación pendientes.', d_net_to_release: 'Neto a liberar', d_requested: 'Solicitado', d_plan: 'Plan',
            d_no_other_cc: 'Sin otros reclamos o cargos pendientes.', d_approve: 'Aprobar', d_reject: '✕ Rechazar', d_requested_by: 'solicitado por',
            d_no_provider_set: 'Nadie está configurado con pago <strong>Proveedor</strong> aún. Vaya a la pestaña Empleados y cambie el Pago de una persona a <em>Proveedor</em>.',
            d_amount_this_week: 'Monto de esta semana', d_notes_optional: 'Notas (opcional)', d_provider_notes_ph: 'p. ej. n.º de factura, concepto', d_total_this_week: 'Total de esta semana',
            d_dp_setup: '⚙️ <strong>Se necesita configuración única.</strong> Las tablas de pago diario aún no existen en su base de datos, por lo que no se pueden guardar entradas. Pida a su administrador que ejecute la breve configuración SQL (incluida con esta actualización) en Supabase → SQL Editor. Todo lo demás en la app sigue funcionando normalmente.',
            d_no_daily_set: 'Nadie está configurado con <strong>Tarifa diaria</strong> aún. Vaya a la pestaña Empleados y cambie el Pago de una persona a <em>Diaria</em> (el botón ↺ en la columna Pago).',
            d_week_total: 'Total semanal',
            // --- R5a: dynamic card chrome — Companies, Invoices, Bills, Approvals, Log, Notifications, Messages, Home, Changelog, Users/Sessions ---
            d_no_companies: 'Aún no hay compañías.', d_created: 'Creado', d_manager_phone: 'Teléfono del gerente',
            d_no_line_items: 'Sin conceptos.', d_no_line_items_hint: 'Aún no hay conceptos — haga clic en "+ Agregar línea", o simplemente guarde solo con el total de abajo.', d_desc_route_ph: 'Descripción / ruta', d_rate_ph: 'Tarifa', d_qty_ph: 'Cant.', d_extra_ph: 'Extra', d_amount_ph: 'Monto',
            d_stat_unpaid: 'Sin pagar', d_invoiced_month: 'Facturado este mes', d_total_invoices: 'Total de facturas', d_no_invoices: 'No se encontraron facturas.',
            d_overdue: 'Vencidas', d_total_bills: 'Total de cuentas', d_no_bills: 'No se encontraron cuentas.',
            d_no_pending: 'No hay solicitudes pendientes.', d_th_requested_by: 'Solicitado por', d_th_record: 'Registro', d_th_old: 'Anterior', d_th_new: 'Nuevo', d_th_requested: 'Solicitado',
            d_record: 'Registro', d_old_value: 'Valor anterior', d_new_value: 'Valor nuevo',
            d_no_changes_logged: 'Aún no hay cambios registrados.',
            d_no_notifs: 'No hay notificaciones en este rango.',
            d_no_convos: 'Aún no hay conversaciones. Toque + para iniciar una.', d_you_prefix: 'Tú:', d_new_conversation: 'Nueva conversación', d_pick_person: '— Elegir una persona —', d_open_chat: 'Abrir chat',
            d_home_active_emps: 'Empleados activos', d_home_open_claims: 'Reclamos abiertos', d_home_active_charges: 'Cargos activos', d_home_income_week: 'Ingreso de esta semana', d_home_expiring: 'Por vencer pronto', d_home_unread: 'Notificaciones sin leer',
            d_no_versions: 'Aún no hay versiones registradas.', d_current: 'Actual',
            d_no_sessions: 'No hay sesiones activas.', d_th_user: 'Usuario', d_th_started: 'Iniciada', d_th_last_seen: 'Última actividad', d_th_ends: 'Termina', d_sign_out_btn: 'Cerrar sesión', d_this_device: 'Este dispositivo',
            d_no_failed: 'No hay inicios de sesión fallidos en los últimos 7 días.', d_th_type: 'Tipo', d_th_who: 'Quién', d_th_failed: 'Fallidos', d_th_last_attempt: 'Último intento',
            d_no_users: 'No se encontraron usuarios.', d_restricted: 'Restringido', d_id_btn: '🪪 ID', d_reset_pw: '🔑 Restablecer', d_reset_2fa: '🔐 Restablecer 2FA',
            d_no_gso: 'Aún no hay cierres de sesión globales.', d_th_initiator: 'Iniciador', d_th_scope: 'Alcance', d_th_grace: 'Gracia', d_th_affected: 'Afectados', d_th_reason: 'Motivo', d_all_companies: 'Todas las compañías',
            fv_close: 'Cerrar', fv_download: 'Descargar', fv_uploaded_by: 'Subido por', fv_loading: 'Cargando…', fv_no_preview: 'Vista previa no disponible para este tipo de archivo — descárguelo para verlo.', fv_error: 'No se pudo abrir este archivo.', fv_zoom_in: 'Acercar', fv_zoom_out: 'Alejar', fv_zoom_reset: 'Restablecer zoom', fv_prev: 'Anterior', fv_next: 'Siguiente', fv_rotate_left: 'Girar a la izquierda', fv_rotate_right: 'Girar a la derecha', fv_flip_h: 'Voltear horizontal', fv_flip_v: 'Voltear vertical',
            // ---- Pop-up messages (alert/confirm/prompt) — shared error prefixes ----
            err_prefix: 'Error: ', err_could_not_reach: 'No se pudo conectar con el servidor: ',
            // 00-core (deduction rate/pause history)
            a_enter_amount_date: 'Ingrese un nuevo monto semanal y una fecha de vigencia.', a_weekly_neg: 'El monto semanal no puede ser negativo.', a_rate_change_exists: 'Ya existe un cambio de tarifa vigente el {date} para este {label}. Elimine primero el existente si desea reemplazarlo.', a_enter_paused_date: 'Ingrese una fecha de pausa.', a_resume_after_paused: 'La fecha estimada de reanudación debe ser posterior a la fecha de pausa.', a_pause_overlaps: 'Esto se superpone con una pausa existente para este {label}. Elimine o ajuste primero la existente.', a_no_rate_id: 'Error: no se pudo identificar qué cambio de tarifa eliminar — intente actualizar la página.', c_remove_rate_change: '¿Eliminar este cambio de tarifa?', a_no_pause_id: 'Error: no se pudo identificar qué pausa eliminar — intente actualizar la página.', c_remove_pause: '¿Eliminar este registro de pausa?',
            // 10-auth (2FA / sign-out)
            c_cancel_signout: '¿Cancelar el cierre de sesión programado para todos?', a_2fa_off: 'La autenticación de dos factores se ha desactivado.', c_reset_2fa: '¿Desactivar la autenticación de dos factores para "{user}"?\n\nUse esto solo si perdió su dispositivo. Se le pedirá configurarla de nuevo la próxima vez que inicie sesión (si su rol lo requiere).', a_2fa_reset_for: 'La autenticación de dos factores se restableció para "{user}".',
            err_could_not_save: 'No se pudo guardar: ', err_saving_claim: 'Error al guardar el reclamo: ', err_saving_charge: 'Error al guardar el cargo: ',
            // 20-employees-claims
            a_pw_updated: 'Contraseña actualizada correctamente.', a_select_company_first: 'Seleccione primero una compañía específica (menú superior derecho) antes de agregar registros.', a_company_code_len: 'El código de compañía debe tener 3 o 4 caracteres.', a_enter_company_name: 'Ingrese un nombre de compañía.', a_copied: 'Copiado al portapapeles.', c_del_company: '¿Eliminar la compañía {code} y TODOS sus datos (empleados, rutas, reclamos, cargos, usuarios)? Esto no se puede deshacer.', a_print_ios: 'La impresión no funciona de forma confiable desde el ícono de la app instalada — es una limitación antigua de Safari en iPhone/iPad, no algo de Tracker.\n\nPara imprimir: abra esta misma página en Safari (no el ícono de la pantalla de inicio) e imprima desde ahí.', a_emp_details_missing: 'La tabla employee_details aún no está configurada — los campos de ID adicionales (licencia, permiso, tarjeta médica, notas) no se guardaron. Ejecute una vez la configuración SQL proporcionada y vuelva a guardar.', a_no_import_perm: 'No tiene permiso para importar.', a_csv_empty: 'El CSV parece estar vacío.', a_csv_cols: 'El CSV debe incluir al menos las columnas "First Name" y "Last Name".', a_import_done: 'Importación finalizada: {ok} agregados{fail}.', a_import_fail_suffix: ', {n} fallaron (ver consola)', c_del_employee: '¿Eliminar al empleado {id}?', c_gen_login: '¿Generar un acceso para {name}?', a_no_account: 'No se devolvió ninguna cuenta — revise la pestaña Usuarios.', a_select_valid_emp: 'Seleccione un empleado válido de la lista.', a_select_emp_first: 'Seleccione primero un empleado.',
            err_saving_income: 'Error al guardar el ingreso: ', err_save_paytype: 'No se pudo guardar el tipo de pago: ', err_saving: 'Error al guardar: ', err_paying_bill: 'Error al pagar la factura {bill}: ',
            // 40-income-provider
            a_income_table_missing: 'La tabla additional_income aún no está configurada. Ejecute primero el SQL de configuración de ingresos.', a_select_emp_top: 'Seleccione primero un empleado en la parte superior de la pestaña.', a_no_income_id: 'Error: no se pudo identificar qué registro de ingreso eliminar — intente actualizar la página.', c_del_income: '¿Eliminar el ingreso {id}?', a_dailypay_missing: 'Las tablas de pago diario aún no están configuradas. Vea la nota amarilla en la pestaña Pago Diario.', c_set_emp_status: '¿Cambiar a {name} a {status}?', a_tick_bill: 'Marque al menos una factura para pagar.', c_mark_bills_paid: '¿Marcar {n} factura(s) como Pagadas ({amount}) y agregar eso al pago de proveedor de esta semana?', a_no_net_pay: 'Nadie en la vista actual tiene un monto neto a pagar para esta semana.',
            err_could_not_send: 'No se pudo enviar el archivo: ',
            // 50-messages
            a_pick_person: 'Elija primero una persona.', a_pick_topic: 'Elija primero un tema.', a_pick_date: 'Elija una fecha para el hilo de Día Faltante.', a_pick_which: 'Elija sobre qué {kind} trata esta conversación.', a_pick_convo: 'Elija primero una conversación (toque +).', c_del_message: '¿Eliminar este mensaje?', a_share_file_hint: 'Para compartir un archivo, abra una conversación de Reclamo, Cargo o Ingreso — el archivo se adjunta a ese registro. (Los chats General y de Día Faltante no tienen un registro al cual adjuntar.)', a_own_files_only: 'Solo puede compartir archivos en sus propios reclamos, cargos e ingresos.', a_edit_prompt_hint: '\nDeje un valor sin cambios para conservarlo. Presione Cancelar en cualquier campo para detenerse.', a_must_be_number: '"{field}" debe ser un número. No se guardó nada.', a_release_done: 'Liberación aprobada y completada.', c_reject_change: '¿Rechazar esta solicitud de cambio?', c_approve_release: '¿Aprobar y ejecutar esta liberación ahora?', c_reject_release: '¿Rechazar esta solicitud de liberación?',
            // 70-financial-init
            a_enter_customer: 'Ingrese un nombre de cliente.', c_del_invoice: '¿Eliminar la factura {id} y todas sus líneas?', a_enter_desc: 'Ingrese una descripción.', a_enter_vendor: 'Ingrese un nombre de proveedor.', c_del_bill: '¿Eliminar la cuenta {id}?', c_del_vehicle: '¿Eliminar este vehículo y todo su historial de servicio?', a_enter_date_desc: 'Ingrese una fecha y una descripción.', a_pick_truck: 'Elija un camión.', a_no_export: '¡No hay datos para exportar!',
            err_could_not_upload: 'No se pudo subir: ', err_importing_file: 'Error al importar el archivo: ', err_parsing_file: 'Error al analizar el archivo: ', err_importing: 'Error al importar: ', err_parsing_sheet: 'Error al analizar la hoja: ',
            // 30-attach-import-deposit
            p_rename_file: 'Renombrar archivo', c_del_file: '¿Eliminar este archivo? Esto no se puede deshacer.', c_del_claim: '¿Eliminar el reclamo {id}?', a_file_empty: 'El archivo parece estar vacío.', a_no_date_cols: 'No se encontraron columnas de semana/fecha a partir de la columna B — verifique el formato del archivo.', a_no_goal_col: 'No se encontró la columna del monto objetivo (se esperaba un encabezado que contenga "final" o "goal") después de las columnas de fecha.', a_no_first_week: 'No se pudo leer la fecha de la primera semana en la columna B.', a_sheet_empty: 'Esa hoja parece estar vacía.', a_no_7days: 'No se encontraron 7 fechas de día en la fila 2 (columnas D–J) de "{sheet}". Asegúrese de que coincida con el formato del registro de Pago Diario.', a_no_dailypay_rows: 'No se encontraron filas de pago diario importables en esta hoja.', a_no_data_rows: 'No se encontraron filas de datos en la pestaña "{sheet}".', a_no_matching_cols: 'Se encontraron {n} fila(s) en "{sheet}" pero ninguna tenía datos en las columnas Employee o Internal RefClaim — verifique que la hoja tenga esos encabezados.', c_del_charge: '¿Eliminar el cargo {id}?', a_save_emp_first: 'Guarde primero a este empleado, luego edítelo para tomar datos de Pago Diario.', a_no_dailypay_emp: 'No se encontraron entradas de Pago Diario para este empleado.', c_mark_inactive: '¿Marcar a {name} como Inactivo? Esto fija la fecha de hoy como su fecha de salida (si aún no está establecida) y retiene sus ahorros de Semana en Fondo (90 días) y su último cheque (30 días) según las reglas de liberación.', a_not_releasable: 'Esta cuenta aún no se puede liberar. Según la Última Fecha Trabajada de este empleado, la fecha elegible más temprana es {date}. Use "Liberación Anticipada" si esto debe ocurrir antes.', c_no_ldw_90: 'Este empleado no tiene una Última Fecha Trabajada registrada, por lo que no se puede verificar la regla de elegibilidad de 90 días. ¿Continuar de todos modos?', a_early_release_date: 'Esta es una liberación ANTICIPADA — la fecha elegible normal es {date}. {tail}', a_ldw_unknown: 'desconocida (sin Última Fecha Trabajada registrada)', a_will_send_admin: 'Esto se enviará a un Administrador para su aprobación.', a_continue_q: '¿Continuar?', a_paycheck_released: 'El último cheque de este empleado ya fue liberado.', a_not_releasable2: 'Esto aún no se puede liberar. Según la Última Fecha Trabajada de este empleado, la fecha elegible más temprana es {date}. Use "Liberación Anticipada" si esto debe ocurrir antes.', c_no_ldw_30: 'Este empleado no tiene una Última Fecha Trabajada registrada, por lo que no se puede verificar la regla de elegibilidad de 30 días. ¿Continuar de todos modos?', a_over_committed: 'Desmarque algo primero — el total seleccionado es mayor que lo disponible.', a_enter_paycheck: 'Ingrese primero el monto del cheque.', a_sent_approval: 'Enviado para aprobación del Administrador — aún no se ha liberado nada. Lo verá cambiar una vez que se haya actuado sobre él.',
            // 60-i18n-sessions (settings / users / bulk-admin / routes)
            a_no_damage_id: 'Error: no se pudo identificar qué tipo de daño eliminar — intente actualizar la página.', a_no_chargetype_id: 'Error: no se pudo identificar qué tipo de cargo eliminar — intente actualizar la página.', a_no_incometype_id: 'Error: no se pudo identificar qué tipo de ingreso eliminar — intente actualizar la página.', a_id_settings_updated: '¡Configuración de ID actualizada para registros futuros!', c_change_role: '¿Cambiar el rol de {user} de {old} a {new}?', c_signout_session: '¿Cerrar esta sesión de {who}? Deberá iniciar sesión de nuevo.', c_signout_others: '¿Cerrar sesión en todos los demás dispositivos con su cuenta? Este dispositivo permanece conectado.', p_new_password: 'Ingrese una nueva contraseña para "{user}":', a_pw_min: 'La contraseña debe tener al menos 8 caracteres.', a_pw_reset_for: 'La contraseña de "{user}" se ha restablecido.', p_employee_id: 'ID de empleado para "{user}" (deje en blanco para desvincular):', c_del_user: '¿Está seguro de que desea eliminar al usuario "{user}"?', a_user_deleted: 'Usuario "{user}" eliminado correctamente.', a_assign_user_emp: 'Asigne este usuario a un empleado.', a_select_company_user: 'Seleccione primero una compañía específica (menú superior derecho) antes de crear un usuario.', a_user_created: '¡Usuario creado correctamente!', a_access_denied: 'Acceso denegado. Se requieren privilegios de Administrador.', a_select_company_bulk: 'Seleccione primero una compañía específica (menú superior derecho). Las acciones masivas se aplican a una compañía a la vez.', c_del_all_routes: '¿Eliminar TODOS los registros de rutas de la compañía {co}?', a_routes_deleted: 'Rutas eliminadas para {co}.', c_del_all_users: 'ADVERTENCIA: Esto elimina TODAS las cuentas de usuario EXCEPTO la suya. ¿Continuar?', a_all_users_deleted: 'Todos los demás usuarios fueron eliminados. Su cuenta se conservó.', c_del_all_claims: '¿Eliminar TODOS los reclamos de la compañía {co}?', a_claims_deleted: 'Reclamos eliminados para {co}.', c_del_all_charges: '¿Eliminar TODOS los cargos de la compañía {co}?', a_charges_deleted: 'Cargos eliminados para {co}.', c_wipe_company: 'CRÍTICO: Borrar TODOS los datos operativos (rutas, empleados, reclamos, cargos) de la compañía {co}, excepto las cuentas de usuario. No se puede deshacer. ¿Continuar?', a_opdata_reset: 'Datos operativos restablecidos para {co}.', p_reset_system: 'Esto elimina todas las cuentas de usuario excepto los Súper Admin, y borra el Registro y las Aprobaciones. Las compañías y sus datos se conservan.\n\nEscriba RESET SYSTEM para confirmar:', a_not_confirmed: 'No confirmado — no se cambió nada.', a_system_reset_done: 'Restablecimiento del sistema completo. Se eliminaron todas las cuentas que no son Súper Admin; el Registro y las Aprobaciones están vacíos. Los datos de las compañías no se modificaron.', a_select_company_route: 'Seleccione una Compañía para esta ruta.', a_tab_empty: 'La pestaña \'{sheet}\' del archivo de Excel está vacía.', a_routes_imported: '¡Se importaron y sincronizaron correctamente {n} rutas de la pestaña \'{sheet}\'!', c_del_route: '¿Eliminar esta ruta?',
            // ES-B: computed enum/status DISPLAY values (stored value stays English; only the shown text is localized)
            ev_active: 'Activo', ev_inactive: 'Inactivo', ev_deducting: 'Deduciendo', ev_paying: 'Pagando', ev_queued: 'En cola', ev_paid: 'Pagado', ev_absorbed: 'Absorbido', ev_tk_from_check: 'Tomado del cheque', ev_stopped: 'Detenido', ev_released: 'Liberado', ev_paused: 'Pausado', ev_unpaid: 'No pagado', ev_void: 'Anulado', ev_new: 'Nuevo', ev_performed: 'Realizado', ev_planned: 'Planificado', ev_daily: 'Diario', ev_weekly: 'Semanal', ev_provider: 'Proveedor', ev_employee: 'Empleado', ev_staff: 'Personal', ev_contractor: 'Contratista', ev_owner: 'Propietario', ev_manager: 'Gerente',
            // v3.63: fotos de perfil (opcional)
            photo_change: 'Cambiar foto', photo_remove: 'Quitar foto', photo_optional: 'Opcional — nunca se exige una foto.', c_remove_photo: '¿Quitar esta foto de perfil?', err_photo_not_image: 'Elige un archivo de imagen.', err_photo_save: 'No se pudo guardar la foto: ', err_photo_remove: 'No se pudo quitar la foto: ',
            // v3.64: selector de emojis
            em_search_ph: 'Buscar emoji', em_no_recent: 'Aún no hay emojis recientes', em_no_match: 'No se encontraron emojis',
            // v3.65: menú de cuenta condensado
            acct_photo: 'Foto de perfil', acct_security: 'Seguridad',
            // v3.70 (Tracker 4.0 P3): navegación por secciones
            hub_home: 'Inicio', hub_operations: 'Operaciones', hub_people: 'Personas', hub_payroll: 'Nómina', hub_finance: 'Finanzas', hub_documents: 'Documentos', hub_messages: 'Mensajes', hub_admin: 'Admin', hub_more: 'Más', tab_overview: 'Resumen',
            // v3.71 (Tracker 4.0 P4): inicio tipo "centro de control"
            greet_morning: 'Buenos días', greet_afternoon: 'Buenas tardes', greet_evening: 'Buenas noches',
            attn_review: 'Revisar', attn_paychecks: 'Decisiones de cheque', attn_msgs: 'Mensajes sin leer',
            qa_new_claim: 'Nuevo reclamo', qa_add_person: 'Agregar persona', qa_new_invoice: 'Nueva factura',
            // v3.72 (Tracker 4.0 final): inicio "centro de control" completo
            home_needs_attention: 'Esto es lo que necesita tu atención.', qa_upload_doc: 'Subir documento',
            attn_approvals: 'Aprobaciones pendientes', attn_capt_approvals: 'Liberaciones esperando por ti',
            attn_capt_paychecks: 'Últimos cheques retenidos', attn_capt_expiring: 'En los próximos 30 días',
            attn_capt_msgs: 'En tus conversaciones', attn_capt_notifs: 'Desde tu última visita',
            hp_title: 'Nómina de esta semana', hp_open: 'Abrir nómina', hp_net: 'Neto a pagar', hp_week: 'Semana', hp_inprog: 'en curso',
            ra_title: 'Actividad reciente', ra_viewall: 'Ver todo', ra_today: 'Hoy', ra_events: 'eventos'
        }
    };

    // The English/Spanish switcher is live. Coverage spans every tab's fixed
    // UI plus the dynamically-rendered record cards; any still-untranslated
    // string (a handful of pop-up messages, enum/status values) falls back to
    // English automatically via the ?? below, so a missing key never breaks a
    // screen. The two picker blocks (login screen + Settings) are visible.
    const LANGUAGE_SWITCH_HIDDEN = false;
    function currentLang() {
        if (LANGUAGE_SWITCH_HIDDEN) return 'en';
        try {
            const saved = localStorage.getItem('tracker_lang');
            if (saved === 'en' || saved === 'es') return saved;
            // First run with no saved choice: follow the device language for
            // Spanish, otherwise English. Not persisted — only an explicit pick
            // (a picker button) writes tracker_lang, so this stays a soft default.
            const nav = (navigator.language || navigator.userLanguage || '').toLowerCase();
            return nav.startsWith('es') ? 'es' : 'en';
        } catch (e) { return 'en'; }
    }
    function t(key) {
        const lang = currentLang();
        return (TRANSLATIONS[lang] && TRANSLATIONS[lang][key]) ?? TRANSLATIONS.en[key];
    }

    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const val = t(el.getAttribute('data-i18n'));
            if (val === undefined) return;
            // A translation value containing HTML markup (e.g. <strong> in a
            // note box) fully replaces this element's contents — there's
            // nothing else inside it worth preserving.
            if (/<[a-z][\s\S]*>/i.test(val)) { el.innerHTML = val; return; }
            // Some tagged elements (panel headers with a caret span, tab
            // buttons with a badge span) have element children alongside
            // their text — only swap the first text node so those don't
            // get wiped out.
            const hasElementChildren = Array.from(el.childNodes).some(n => n.nodeType === 1);
            if (hasElementChildren) {
                const textNode = Array.from(el.childNodes).find(n => n.nodeType === 3 && n.textContent.trim());
                if (textNode) textNode.textContent = val + ' ';
                else el.insertBefore(document.createTextNode(val + ' '), el.firstChild);
            } else {
                el.textContent = val;
            }
        });
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const val = t(el.getAttribute('data-i18n-placeholder'));
            if (val !== undefined) el.placeholder = val;
        });
    }

    function setLanguage(lang) {
        try { localStorage.setItem('tracker_lang', lang === 'es' ? 'es' : 'en'); } catch (e) {}
        applyTranslations();
        updateLanguageButtons();
    }

    function updateLanguageButtons() {
        const cur = currentLang();
        const enBtn = document.getElementById('lang-btn-en'), esBtn = document.getElementById('lang-btn-es');
        const loginEnBtn = document.getElementById('login-lang-btn-en'), loginEsBtn = document.getElementById('login-lang-btn-es');
        [enBtn, loginEnBtn].forEach(b => { if (b) b.style.background = cur === 'en' ? 'var(--navy)' : '#64748b'; });
        [esBtn, loginEsBtn].forEach(b => { if (b) b.style.background = cur === 'es' ? 'var(--navy)' : '#64748b'; });
    }

    // Applies to whichever selector set is passed in — lets both the Settings
    // panel and the login screen (different button IDs) share this logic.
    function setTheme(theme, idPrefix) {
        try {
            const d = document.documentElement;
            d.removeAttribute('data-flavor');
            if (theme === 'dark' || theme === 'dark-emerald' || theme === 'indigo') {
                d.setAttribute('data-theme', theme);
            } else if (theme === 'carbon') {
                // Carbon reuses every dark-mode rule via data-theme="dark",
                // then recolors through the [data-flavor="carbon"] token block.
                d.setAttribute('data-theme', 'dark');
                d.setAttribute('data-flavor', 'carbon');
            } else {
                d.removeAttribute('data-theme');
                theme = 'light';
            }
            localStorage.setItem('tracker_theme', theme);
        } catch (e) { /* storage unavailable — theme still applies for this session */ }
        updateThemeButtons();
    }
    function updateThemeButtons() {
        let cur = 'light';
        try { cur = localStorage.getItem('tracker_theme') || 'light'; } catch (e) {}
        // Settings tab — unchanged text-button behavior.
        const lb = document.getElementById('theme-btn-light');
        const ob = document.getElementById('theme-btn-ocean');
        const eb = document.getElementById('theme-btn-emerald');
        if (lb) { lb.style.background = cur === 'light' ? 'var(--navy)' : '#64748b'; lb.textContent = cur === 'light' ? '☀ Light (current)' : '☀ Light'; }
        if (ob) { ob.style.background = cur === 'dark' ? 'var(--navy)' : '#64748b'; ob.textContent = cur === 'dark' ? '🌊 Ocean (current)' : '🌊 Ocean'; }
        if (eb) { eb.style.background = cur === 'dark-emerald' ? 'var(--navy)' : '#64748b'; eb.textContent = cur === 'dark-emerald' ? '🟢 Emerald (current)' : '🟢 Emerald'; }
        // Login screen — circular swatches, active one gets a ring instead of text/background changes.
        const swatchFor = { light: 'login-theme-btn-light', dark: 'login-theme-btn-ocean', 'dark-emerald': 'login-theme-btn-emerald', indigo: 'login-theme-btn-indigo', carbon: 'login-theme-btn-carbon' };
        ['login-theme-btn-light', 'login-theme-btn-ocean', 'login-theme-btn-emerald', 'login-theme-btn-indigo', 'login-theme-btn-carbon'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', id === swatchFor[cur]);
        });
        // Header dropdown — same idea, quick access without signing out.
        const headerSwatchFor = { light: 'header-theme-btn-light', dark: 'header-theme-btn-ocean', 'dark-emerald': 'header-theme-btn-emerald', indigo: 'header-theme-btn-indigo', carbon: 'header-theme-btn-carbon' };
        ['header-theme-btn-light', 'header-theme-btn-ocean', 'header-theme-btn-emerald', 'header-theme-btn-indigo', 'header-theme-btn-carbon'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', id === headerSwatchFor[cur]);
        });
        // Sidebar account bar (desktop) — same idea again.
        const sidebarSwatchFor = { light: 'sidebar-theme-btn-light', dark: 'sidebar-theme-btn-ocean', 'dark-emerald': 'sidebar-theme-btn-emerald', indigo: 'sidebar-theme-btn-indigo', carbon: 'sidebar-theme-btn-carbon' };
        ['sidebar-theme-btn-light', 'sidebar-theme-btn-ocean', 'sidebar-theme-btn-emerald', 'sidebar-theme-btn-indigo', 'sidebar-theme-btn-carbon'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.toggle('active', id === sidebarSwatchFor[cur]);
        });
    }

    function renderSettingsLists() {
        updateThemeButtons();
        const dBody = document.getElementById('damage-types-tbody');
        if(dBody) {
            dBody.innerHTML = '';
            damageTypes.forEach(d => {
                dBody.insertAdjacentHTML('beforeend', `<tr><td>${escHtml(d)}</td><td style="text-align:center;"><button class="del-btn" onclick="removeDamageType('${escJsAttr(d)}')">✕</button></td></tr>`);
            });
        }

        const cBody = document.getElementById('charge-types-tbody');
        if(cBody) {
            cBody.innerHTML = '';
            chargeTypes.forEach(ct => {
                cBody.insertAdjacentHTML('beforeend', `<tr><td>${escHtml(ct)}</td><td style="text-align:center;"><button class="del-btn" onclick="removeChargeType('${escJsAttr(ct)}')">✕</button></td></tr>`);
            });
        }

        const iBody = document.getElementById('income-types-tbody');
        if(iBody) {
            iBody.innerHTML = '';
            incomeTypes.forEach(it => {
                iBody.insertAdjacentHTML('beforeend', `<tr><td>${escHtml(it)}</td><td style="text-align:center;"><button class="del-btn" onclick="removeIncomeType('${escJsAttr(it)}')">✕</button></td></tr>`);
            });
        }
    }

    document.getElementById('add-damage-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const val = document.getElementById('new-damage-input').value.trim();
        if(!val || damageTypes.includes(val)) return;
        await supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'damage', p_value: val });
        damageTypes.push(val);
        document.getElementById('new-damage-input').value = '';
        renderSettingsLists();
        populateDropdowns();
        populateClaimFilters();
    });

    async function removeDamageType(name) {
        if (!name) { alert(t('a_no_damage_id')); return; }
        const { error } = await supabaseClient.rpc('remove_type_value', { p_actor: currentUsername, p_kind: 'damage', p_value: name });
        if (error) { alert(t('err_prefix') + error.message); return; }
        damageTypes = damageTypes.filter(d => d !== name);
        renderSettingsLists();
        populateDropdowns();
        populateClaimFilters();
    }

    document.getElementById('add-charge-type-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const val = document.getElementById('new-charge-type-input').value.trim();
        if(!val || chargeTypes.includes(val)) return;
        await supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'charge', p_value: val });
        chargeTypes.push(val);
        document.getElementById('new-charge-type-input').value = '';
        renderSettingsLists();
        populateDropdowns();
    });

    async function removeChargeType(name) {
        if (!name) { alert(t('a_no_chargetype_id')); return; }
        const { error } = await supabaseClient.rpc('remove_type_value', { p_actor: currentUsername, p_kind: 'charge', p_value: name });
        if (error) { alert(t('err_prefix') + error.message); return; }
        chargeTypes = chargeTypes.filter(ct => ct !== name);
        renderSettingsLists();
        populateDropdowns();
    }

    document.getElementById('add-income-type-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const val = document.getElementById('new-income-type-input').value.trim();
        if(!val || incomeTypes.includes(val)) return;
        const { error } = await supabaseClient.rpc('add_type_value', { p_actor: currentUsername, p_kind: 'income', p_value: val });
        if (error) { alert(isMissingTable(error) ? 'Run the income setup SQL first (the income_types table).' : ('Error: ' + error.message)); return; }
        incomeTypes.push(val);
        document.getElementById('new-income-type-input').value = '';
        renderSettingsLists();
        populateDropdowns();
    });

    async function removeIncomeType(name) {
        if (!name) { alert(t('a_no_incometype_id')); return; }
        const { error } = await supabaseClient.rpc('remove_type_value', { p_actor: currentUsername, p_kind: 'income', p_value: name });
        if (error) { alert(t('err_prefix') + error.message); return; }
        incomeTypes = incomeTypes.filter(it => it !== name);
        renderSettingsLists();
        populateDropdowns();
    }

    document.getElementById('id-config-form').addEventListener('submit', function(e) {
        e.preventDefault();
        settings.empDigits = parseInt(document.getElementById('set-emp-digits').value) || 4;
        settings.claimDigits = parseInt(document.getElementById('set-claim-digits').value) || 5;
        settings.chargeDigits = parseInt(document.getElementById('set-charge-digits').value) || 5;
        settings.chargeSuffix = document.getElementById('set-charge-suffix').value.trim();
        alert(t('a_id_settings_updated'));
    });

    // --- USERS MANAGEMENT & INDIVIDUAL DELETION ---
    // Roles the current actor is allowed to assign (Admins can't grant SuperAdmin).
    function allowedRolesForActor() {
        if (currentUserRole === 'SuperAdmin') return ['User', 'Medium', 'Administrator', 'SuperAdmin'];
        if (currentUserRole === 'Administrator') return ['User', 'Medium', 'Administrator'];
        if (currentUserRole === 'Medium') return ['User'];
        return [];
    }
    const ROLE_LABELS = { User: 'User', Medium: 'Medium', Administrator: 'Administrator', SuperAdmin: 'Super Admin' };
    function populateUserRoleOptions() {
        const sel = document.getElementById('new-user-role');
        if (!sel) return;
        sel.innerHTML = allowedRolesForActor().map(r => `<option value="${r}">${ROLE_LABELS[r]}</option>`).join('');
    }
    // Change an existing user's role (Administrators + Super Admins only; the
    // server enforces the same limits — Admins can't grant/alter SuperAdmin).
    async function changeUserRole(username, newRole, oldRole) {
        if (newRole === oldRole) return;
        if (!confirm(t('c_change_role').replace('{user}', username).replace('{old}', oldRole).replace('{new}', newRole))) { fetchUsersList(); return; }
        const { error } = await supabaseClient.rpc('set_user_role', { p_actor: currentUsername, p_target: username, p_new_role: newRole });
        if (error) { alert(t('err_prefix') + error.message); fetchUsersList(); return; }
        fetchUsersList();
    }

    // ===== Sessions & sign-in attempts ====================================
    // Who is signed in, and a way to sign them out. list_sessions returns a
    // surrogate id per session and never the token itself, so this screen can
    // show and revoke sessions without ever being able to impersonate anyone.
    function fmtWhen(iso) {
        if (!iso) return '—';
        const d = new Date(iso), mins = Math.round((Date.now() - d.getTime()) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + 'm ago';
        if (mins < 1440) return Math.round(mins / 60) + 'h ago';
        return d.toLocaleDateString();
    }

    async function loadSessions() {
        const body = document.getElementById('sessions-body');
        const count = document.getElementById('sessions-count');
        if (!body) return;
        body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_loading')}</div>`;
        const { data, error } = await supabaseClient.rpc('list_sessions', {
            p_actor: currentUsername, p_company: currentCompany
        });
        if (error) { body.innerHTML = `<div style="grid-column:1/-1; color:#ef4444; padding:10px;">${escHtml(error.message)}</div>`; return; }
        const rows = data || [];
        if (count) count.textContent = `(${rows.length})`;
        if (!rows.length) { body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_no_sessions')}</div>`; return; }
        // Only an Administrator or SuperAdmin may sign someone else out; anyone
        // may end their own session.
        const canRevokeOthers = currentUserRole === 'SuperAdmin' || currentUserRole === 'Administrator';
        const trs = rows.map(r => {
            const mine = r.username === currentUsername;
            const allowed = mine || canRevokeOthers;
            const action = (allowed && !r.is_current)
                ? `<button type="button" class="btn-small del-btn" style="margin:0;" onclick="revokeSession(${r.id}, '${escJsAttr(r.username)}')">${t('d_sign_out_btn')}</button>`
                : '';
            return `<tr>
                <td>${escHtml(r.username)}${r.is_current ? ` <span class="status-badge status-active">${t('d_this_device')}</span>` : ''}</td>
                <td><span class="type-pill" style="font-size:9px; padding:1px 6px;">${escHtml(r.role === 'User' ? 'View Only' : r.role)}</span></td>
                <td style="white-space:nowrap;">${fmtWhen(r.created_at)}</td>
                <td style="white-space:nowrap;">${fmtWhen(r.last_seen)}</td>
                <td style="white-space:nowrap;">${new Date(r.expires_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</td>
                <td style="text-align:center;">${action}</td>
            </tr>`;
        }).join('');
        body.className = '';
        body.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('d_th_user')}</th><th>${t('role_field')}</th><th>${t('d_th_started')}</th><th>${t('d_th_last_seen')}</th><th>${t('d_th_ends')}</th><th>${t('th_action')}</th>
        </tr></thead><tbody>${trs}</tbody></table></div>`;
    }

    async function revokeSession(id, who) {
        if (!confirm(t('c_signout_session').replace('{who}', who))) return;
        const { error } = await supabaseClient.rpc('revoke_session', { p_actor: currentUsername, p_id: id });
        if (error) { alert(t('err_prefix') + error.message); return; }
        loadSessions();
    }

    async function signOutOtherDevices() {
        if (!confirm(t('c_signout_others'))) return;
        const { data, error } = await supabaseClient.rpc('revoke_my_other_sessions', { p_actor: currentUsername });
        if (error) { alert(t('err_prefix') + error.message); return; }
        const n = parseInt(data, 10) || 0;
        alert(n ? `Signed out ${n} other device${n === 1 ? '' : 's'}.` : 'No other devices were signed in.');
        if (document.getElementById('sessions-body')) loadSessions();
    }

    async function loadLoginAttempts() {
        const body = document.getElementById('login-attempts-body');
        const count = document.getElementById('login-attempts-count');
        if (!body) return;
        body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_loading')}</div>`;
        const { data, error } = await supabaseClient.rpc('list_login_attempts', { p_actor: currentUsername });
        if (error) { body.innerHTML = `<div style="grid-column:1/-1; color:#ef4444; padding:10px;">${escHtml(error.message)}</div>`; return; }
        const rows = data || [];
        if (count) count.textContent = `(${rows.length})`;
        if (!rows.length) { body.innerHTML = `<div style="grid-column:1/-1; color:var(--text-muted); padding:10px;">${t('d_no_failed')}</div>`; return; }
        const trs = rows.map(r => {
            const locked = r.locked_until && new Date(r.locked_until) > new Date();
            return `<tr>
                <td><span class="type-pill" style="font-size:9px; padding:1px 6px;">${r.kind === 'network' ? 'Network' : 'Account'}</span></td>
                <td style="font-family:var(--mono);">${escHtml(r.subject)}${(r.kind !== 'network' && r.emp_id) ? ` <span style="color:var(--text-muted);">(${escHtml(r.emp_id)})</span>` : ''}</td>
                <td style="text-align:center; color:${r.fail_count >= 5 ? '#dc2626' : 'var(--text-muted)'}; font-weight:700;">${r.fail_count}</td>
                <td style="text-align:center;">${locked ? '<span class="exp-pill exp-over">locked</span>' : ''}</td>
                <td style="white-space:nowrap; font-family:var(--mono);">${fmtWhen(r.last_fail_at)}</td>
            </tr>`;
        }).join('');
        body.className = '';
        body.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('d_th_type')}</th><th>${t('d_th_who')}</th><th>${t('d_th_failed')}</th><th>${t('status_field')}</th><th>${t('d_th_last_attempt')}</th>
        </tr></thead><tbody>${trs}</tbody></table></div>`;
    }

    async function fetchUsersList() {
        const container = document.getElementById('users-table-body');
        if(!container) return;

        container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_loading')}</div>`;

        let data, error;
        try {
            ({ data, error } = await supabaseClient.rpc('list_users', { p_actor: currentUsername, p_company: currentCompany }));
        } catch (e) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">Could not load users: ${e && e.message ? e.message : e}</div>`;
            console.error('fetchUsersList (network/client):', e);
            return;
        }
        if (error) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:#ef4444; padding:1rem;">${error.message}</div>`;
            return;
        }

        // Fill the "assign to employee" dropdown — excluding employees already
        // linked to a user. Wrapped separately so a problem here can't blank
        // the user list below it.
        try {
            const takenEmpIds = new Set((data || []).map(u => u.employee_id).filter(Boolean));
            const empSel = document.getElementById('new-user-employee');
            if (empSel) {
                const avail = employees.filter(emp => !takenEmpIds.has(emp.id))
                    .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, undefined, { sensitivity: 'base' }));
                empSel.innerHTML = `<option value="">${t('select_employee_opt')}</option>` +
                    avail.map(emp => `<option value="${emp.id}">${employeeOptionLabel(emp)}</option>`).join('');
            }
        } catch (e) { console.error('assign-to-employee dropdown:', e); }

        if (!data || !data.length) {
            container.innerHTML = `<div style="grid-column:1/-1; text-align:center; color:var(--text-muted); padding:1rem;">${t('d_no_users')}</div>`;
            return;
        }

        data = applySort(data, 'users', {
            username: u => u.username || '', employee_id: u => u.employee_id || '',
            role: u => u.role || '', created: u => u.created_at || ''
        });

        // One table on every screen size; the .table-wrapper scrolls sideways
        // on a narrow phone rather than switching to cards.
        container.className = '';
        let rows = '';
        data.forEach(u => {
            try {
                const canManage = u.can_manage && (currentUserRole === 'SuperAdmin' || currentUserRole === 'Administrator');
                let roleCell = `<span class="type-pill">${u.role}</span>`;
                if (canManage) {
                    const roles = allowedRolesForActor();
                    const opts = roles.map(r => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
                    roleCell = `<select onchange="changeUserRole('${u.username}', this.value, '${u.role}')" style="width:auto; min-height:34px; padding:4px 6px; font-size:12px;">${opts}</select>`;
                }
                const twofaBtn = u.twofa_enabled ? `<button class="btn-small" style="margin:0 4px 0 0; padding:0.3rem 0.6rem; font-size:0.75rem;" onclick="resetUser2FA('${u.username}')" title="Turn off this user's 2FA (device lost)">${t('d_reset_2fa')}</button>` : '';
                const actionHtml = u.can_manage
                    ? `<button class="btn-small" style="margin:0 4px 0 0; padding:0.3rem 0.6rem; font-size:0.75rem;" onclick="editUserEmployeeId('${u.username}', '${u.employee_id || ''}')">${t('d_id_btn')}</button><button class="btn-small" style="margin:0 4px 0 0; padding:0.3rem 0.6rem; font-size:0.75rem;" onclick="resetUserPassword('${u.username}')">${t('d_reset_pw')}</button>${twofaBtn}<button class="del-btn" onclick="deleteUser('${u.username}')">✕</button>`
                    : `<span style="color:#94a3b8; font-size:11px;">${t('d_restricted')}</span>`;
                rows += `<tr>
                    <td>${u.username}${u.twofa_enabled ? ' <span title="Two-factor on" style="font-size:11px;">🔐</span>' : ''}</td>
                    <td class="id-cell">${u.employee_id || '-'}</td>
                    <td>${roleCell}</td>
                    <td style="white-space:nowrap;">${new Date(u.created_at).toLocaleDateString()}</td>
                    <td style="text-align:center; white-space:nowrap;">${actionHtml}</td>
                </tr>`;
            } catch (e) { console.error('user row render failed for', u && u.username, e); }
        });
        container.innerHTML = `<div class="table-wrapper"><table><thead><tr>
            <th>${t('username_label')}</th><th>${t('sort_employee_id')}</th><th>${t('role_field')}</th><th>${t('d_created')}</th><th>${t('th_action')}</th>
        </tr></thead><tbody>${rows}</tbody></table></div>`;
        updateRecSortUI('users');
    }

    async function resetUserPassword(usernameToReset) {
        const newPass = prompt(t('p_new_password').replace('{user}', usernameToReset));
        if (newPass === null) return; // cancelled
        if (!newPass || newPass.length < 8) {
            alert(t('a_pw_min'));
            return;
        }

        const { error } = await supabaseClient.rpc('reset_user_password', {
            p_actor: currentUsername, p_target: usernameToReset, p_new_password: newPass
        });
        if (error) {
            alert('Error resetting password: ' + error.message);
        } else {
            alert(t('a_pw_reset_for').replace('{user}', usernameToReset));
        }
    }

    // Change (or clear) which employee a user account is linked to, without
    // deleting and recreating the account. The RPC itself enforces that an
    // employee can only ever be linked to one account at a time and that the
    // employee belongs to this user's own company.
    async function editUserEmployeeId(username, currentId) {
        const val = prompt(t('p_employee_id').replace('{user}', username), currentId || '');
        if (val === null) return; // cancelled
        const newId = val.trim() || null;
        if (newId === (currentId || null)) return; // unchanged
        const { error } = await supabaseClient.rpc('set_user_employee_id', {
            p_actor: currentUsername, p_target: username, p_employee_id: newId
        });
        if (error) {
            alert(t('err_prefix') + error.message);
        } else {
            fetchUsersList();
        }
    }

    async function deleteUser(usernameToDel) {
        if (confirm(t('c_del_user').replace('{user}', usernameToDel))) {
            const { error } = await supabaseClient.rpc('delete_user', {
                p_actor: currentUsername, p_target: usernameToDel
            });
            if (error) {
                alert('Error deleting user: ' + error.message);
            } else {
                alert(t('a_user_deleted').replace('{user}', usernameToDel));
                fetchUsersList();
            }
        }
    }

    document.getElementById('create-user-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        const username = document.getElementById('new-username').value.trim();
        const password = document.getElementById('new-user-pass').value;
        const role = document.getElementById('new-user-role').value;
        const employeeId = document.getElementById('new-user-employee').value;
        if (role !== 'SuperAdmin' && !employeeId) { alert(t('a_assign_user_emp')); return; }
        let userCo = writeCompany();
        if (role !== 'SuperAdmin' && !userCo) { alert(t('a_select_company_user')); return; }
        const { error } = await supabaseClient.rpc('create_user', {
            p_actor: currentUsername, p_username: username, p_password: password, p_role: role,
            p_company: userCo, p_employee_id: employeeId || null
        });
        if (error) alert(t('err_prefix') + error.message);
        else {
            alert(t('a_user_created'));
            document.getElementById('create-user-form').reset();
            fetchUsersList();
        }
    });

    // --- ADMINISTRATOR MANAGEMENT & RESET FUNCTIONS ---
    // Bulk actions: allowed for Administrator (own company) and SuperAdmin.
    // Scope: a company must be selected. Deletes are limited to that company.
    function dangerScope() {
        if (currentUserRole !== 'Administrator' && currentUserRole !== 'SuperAdmin') {
            alert(t('a_access_denied'));
            return undefined;
        }
        const co = (currentUserRole === 'SuperAdmin') ? currentCompany : (currentUser ? currentUser.company_code : null);
        if (!co) {
            alert(t('a_select_company_bulk'));
            return undefined;
        }
        return co;
    }

    async function adminDeleteAllRoutes() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(t('c_del_all_routes').replace('{co}', co))) {
            const { error } = await supabaseClient.rpc('delete_all_routes', { p_actor: currentUsername, p_company: co });
            if (error) alert(t('err_prefix') + error.message);
            else alert(t('a_routes_deleted').replace('{co}', co));
            fetchRoutesFromCloud();
        }
    }

    async function adminDeleteAllUsers() {
        if (currentUserRole !== 'Administrator' && currentUserRole !== 'SuperAdmin') {
            alert(t('a_access_denied'));
            return;
        }
        if (confirm(t('c_del_all_users'))) {
            const { error } = await supabaseClient.rpc('delete_all_other_users', { p_actor: currentUsername });
            if (error) alert(t('err_prefix') + error.message);
            else { alert(t('a_all_users_deleted')); fetchUsersList(); }
        }
    }

    async function adminDeleteAllClaims() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(t('c_del_all_claims').replace('{co}', co))) {
            const { error } = await supabaseClient.rpc('delete_all_claims', { p_actor: currentUsername, p_company: co });
            if (error) alert(t('err_prefix') + error.message);
            else alert(t('a_claims_deleted').replace('{co}', co));
            fetchClaimsFromCloud();
        }
    }

    async function adminDeleteAllCharges() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(t('c_del_all_charges').replace('{co}', co))) {
            const { error } = await supabaseClient.rpc('delete_all_charges', { p_actor: currentUsername, p_company: co });
            if (error) alert(t('err_prefix') + error.message);
            else alert(t('a_charges_deleted').replace('{co}', co));
            fetchChargesFromCloud();
        }
    }

    async function adminResetAllDataExceptUsers() {
        const co = dangerScope(); if (co === undefined) return;
        if (confirm(t('c_wipe_company').replace('{co}', co))) {
            try {
                const { error } = await supabaseClient.rpc('reset_company_data', { p_actor: currentUsername, p_company: co });
                if (error) {
                    alert('Error resetting data: ' + error.message);
                } else {
                    alert(t('a_opdata_reset').replace('{co}', co));
                }
                fetchAllDataFromCloud();
            } catch (err) {
                alert('Error resetting data: ' + err.message);
            }
        }
    }

    // System-wide reset, Super Admin only. Every user account except Super
    // Admins, the audit Log, and pending Approvals are cleared; companies and
    // everything that belongs to them are untouched. Requires typing a exact
    // phrase to confirm, given the scale of what this removes.
    async function superAdminResetSystem() {
        if (currentUserRole !== 'SuperAdmin') return;
        const typed = prompt(t('p_reset_system'));
        if (typed !== 'RESET SYSTEM') { if (typed !== null) alert(t('a_not_confirmed')); return; }
        try {
            const { error } = await supabaseClient.rpc('reset_system_data', { p_actor: currentUsername });
            if (error) { alert(t('err_prefix') + error.message); return; }
            alert(t('a_system_reset_done'));
            fetchUsersList();
            renderLog();
            renderApprovals();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    }

    // --- LOGISTICS ROUTE MATH & DB PAYLOAD BUILDER ---
    function buildRoutePayload(rawData) {
        const rates = {
            mileage: 0.60, fuel: 0.40, stop: 18.25, incomplete: 9.125, thirdMan: 125.00, base: 300.00
        };

        const loadedStops = (rawData.manifest || 0) - (rawData.pullbacks || 0);
        const completedStops = loadedStops - (rawData.incompletes || 0);
        const mileagePay = (rawData.miles || 0) * rates.mileage;
        const fuelPay = (rawData.miles || 0) * rates.fuel;
        const stopPay = completedStops * rates.stop;
        const incPay = (rawData.incompletes || 0) * rates.incomplete;
        const thirdManPay = (rawData.third_man_status === 'NYC' || rawData.third_man_status === 'Y') ? rates.thirdMan : 0;
        const totalDaily = mileagePay + fuelPay + stopPay + incPay + thirdManPay + rates.base;
        const finalPay = (rawData.type === 'Dedicated') ? (rawData.dedicated_flat || 0) : (totalDaily - (rawData.deductions || 0) + (rawData.extra_pay || 0));
        
        return {
            id: rawData.id || Date.now(),
            date: rawData.date,
            contractor: rawData.contractor || '3 OF LIFE LLC',
            type: rawData.type || 'Regular',
            driver: rawData.driver || '',
            route_num: rawData.route_num || '',
            route_id: rawData.route_id || '',
            third_man_status: rawData.third_man_status || 'None',
            miles: parseFloat(rawData.miles || 0),
            manifest: parseInt(rawData.manifest || 0),
            pullbacks: parseInt(rawData.pullbacks || 0),
            incompletes: parseInt(rawData.incompletes || 0),
            dedicated_flat: parseFloat(rawData.dedicated_flat || 0),
            deductions: parseFloat(rawData.deductions || 0),
            extra_pay: parseFloat(rawData.extra_pay || 0),
            loaded_stops: loadedStops,
            completed_stops: completedStops,
            mileage_pay: mileagePay,
            fuel_pay: fuelPay,
            total_daily: totalDaily,
            final_pay: finalPay,
            year: getYear(rawData.date),
            week: getWeekNumber(rawData.date).toString()
        };
    }

    document.getElementById('route-form').addEventListener('submit', async function(e) {
        e.preventDefault();
        let rawData = {
            id: editingRouteId || Date.now(),
            date: document.getElementById('f-date').value,
            contractor: document.getElementById('f-contractor').value,
            type: document.getElementById('f-type').value,
            driver: document.getElementById('f-driver').value,
            route_num: document.getElementById('f-routeNum').value,
            route_id: document.getElementById('f-routeId').value,
            third_man_status: document.getElementById('f-3rdman').value,
            miles: document.getElementById('f-miles').value,
            manifest: document.getElementById('f-manifest').value,
            pullbacks: document.getElementById('f-pullbacks').value,
            incompletes: document.getElementById('f-incompletes').value,
            dedicated_flat: document.getElementById('f-dedicated').value,
            deductions: document.getElementById('f-deductions').value,
            extra_pay: document.getElementById('f-extra').value
        };

        const selCode = document.getElementById('f-contractor').value;
        const selCompany = (companies || []).find(c => c.code === selCode);
        const routeCo = selCode || requireWriteCompany();
        if (!routeCo) { alert(t('a_select_company_route')); return; }
        // store the company name in the route's contractor field (keeps the
        // Daily Report grouping working), and scope the record by its code
        rawData.contractor = selCompany ? selCompany.name : (rawData.contractor || selCode);

        if (editingRouteId) {
            // edit_route diffs each key in p_fields against the row's
            // current value and only writes (and audits) the ones that
            // actually changed — but 'id' has no business being in that
            // diff set at all (it happens to always match its own current
            // value here, so the RPC's equal-value skip saves it, but
            // that's incidental, not something to depend on for a primary
            // key column), so it's stripped out explicitly before sending.
            const { id: _unusedId, ...routeFields } = rawData;
            const { data, error } = await supabaseClient.rpc('edit_route', { p_actor: currentUsername, p_id: parseInt(editingRouteId), p_fields: routeFields });
            if (error) { alert(t('err_prefix') + error.message); return; }
            cancelRouteEdit();
            fetchRoutesFromCloud();
            return;
        }

        const payload = buildRoutePayload(rawData);
        payload.company_code = routeCo;
        const { error } = await supabaseClient.rpc('create_route', { p_actor: currentUsername, p_fields: payload });
        if (error) alert(t('err_prefix') + error.message);
        else {
            document.getElementById('route-form').reset();
            fetchRoutesFromCloud();
        }
    });

    // --- EXCEL FILE IMPORT HANDLER (TARGETS 'TRACKER' TAB & SKIPS METADATA ROW) ---
    document.getElementById('file-upload').addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function(evt) {
            try {
                const data = new Uint8Array(evt.target.result);
                const workbook = XLSX.read(data, { type: 'array' });
                
                let targetSheetName = workbook.SheetNames.find(name => name.trim().toLowerCase() === 'tracker');
                if (!targetSheetName) {
                    targetSheetName = workbook.SheetNames[0];
                }
                
                const worksheet = workbook.Sheets[targetSheetName];
                const json = XLSX.utils.sheet_to_json(worksheet, { range: 1 });
                
                if (!json.length) {
                    alert(t('a_tab_empty').replace('{sheet}', targetSheetName));
                    return;
                }

                const importCo = requireWriteCompany();
                if (!importCo) return;
                let newRoutes = [];
                json.forEach((row, index) => {
                    let dStr = row['Delivery Date'] || row['delivery_date'] || row['Date'] || new Date().toISOString().split('T')[0];
                    
                    if (typeof dStr === 'number') {
                        const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                        dStr = new Date(excelEpoch.getTime() + dStr * 86400000).toISOString().split('T')[0];
                    }

                    let rawData = {
                        id: Date.now() + index,
                        date: dStr,
                        contractor: row['Contractor'] || row['contractor'] || '3 OF LIFE LLC',
                        type: row['Regular/Dedicated'] || row['Route Type'] || row['Reg/Ded'] || row['type'] || 'Regular',
                        driver: row['Driver'] || row['driver'] || 'Unknown',
                        route_num: row['Route #'] || row['route_num'] || '',
                        route_id: row['Route ID'] || row['route_id'] || '',
                        third_man_status: row['3rd. Man'] || row['3rd Man'] || row['third_man_status'] || 'None',
                        miles: parseFloat(row['Miles'] || row['miles'] || 0),
                        manifest: parseInt(row['Manifest Stops'] || row['manifest'] || 0),
                        pullbacks: parseInt(row['Pullbacks'] || row['pullbacks'] || 0),
                        incompletes: parseInt(row['Incompletes'] || row['incompletes'] || 0),
                        dedicated_flat: parseFloat(row['Dedicated Flat'] || row['Dedicated Flat Pay'] || row['dedicated_flat'] || 0),
                        deductions: parseFloat(row['Deductions'] || row['deductions'] || 0),
                        extra_pay: parseFloat(row['Extra Pay'] || row['extra_pay'] || 0)
                    };
                    const rp = buildRoutePayload(rawData);
                    rp.company_code = importCo;
                    newRoutes.push(rp);
                });

                const { error } = await supabaseClient.rpc('create_routes_batch', { p_actor: currentUsername, p_rows: newRoutes });
                if (error) {
                    alert('Error syncing routes to Supabase: ' + error.message);
                } else {
                    alert(t('a_routes_imported').replace('{n}', newRoutes.length).replace('{sheet}', targetSheetName));
                    document.getElementById('file-upload').value = '';
                    fetchRoutesFromCloud();
                }
            } catch (err) {
                alert('Error parsing Excel file: ' + err.message);
            }
        };
        reader.readAsArrayBuffer(file);
    });

    function renderTracker() {
        const tbody = document.getElementById('tracker-body');
        const filtered = getFilteredRoutes();
        tbody.innerHTML = filtered.length ? '' : '<tr><td colspan="17" style="text-align:center;">No route records.</td></tr>';
        filtered.forEach(r => {
            tbody.insertAdjacentHTML('beforeend', `
                <tr>
                    <td>${r.date}</td><td style="text-align:center">${escHtml(r.contractor)}</td><td style="text-align:center">${escHtml(r.type)}</td><td style="text-align:center">${escHtml(r.driver)}</td>
                    <td style="text-align:center">${escHtml(r.route_num || '-')}</td><td style="text-align:center">${escHtml(r.route_id || '-')}</td>
                    <td>${r.miles}</td><td>${r.manifest}</td><td>${r.pullbacks || '-'}</td><td>${r.loaded_stops}</td>
                    <td>${r.incompletes || '-'}</td><td>${r.completed_stops}</td><td>${formatMoney(r.mileage_pay)}</td><td>${formatMoney(r.fuel_pay)}</td>
                    <td class="money">${formatMoney(r.total_daily)}</td><td class="money">${formatMoney(r.final_pay)}</td>
                    <td style="text-align:center; white-space:nowrap;">${canEdit() ? `<button class="btn-small" style="padding:0.3rem 0.5rem;font-size:0.75rem;margin:0 3px 0 0;" onclick="editRoute(${r.id})">✎</button>` : ''}<button class="del-btn" onclick="deleteRoute(${r.id})">X</button></td>
                </tr>`);
        });
    }

    async function deleteRoute(id) {
        if(confirm(t('c_del_route'))) {
            const { error } = await supabaseClient.rpc('delete_route', { p_actor: currentUsername, p_id: id });
            if (error) alert(t('err_prefix') + error.message);
            fetchRoutesFromCloud();
        }
    }

    function toggleFilter(category, value) {
        if(filters[category].has(value)) filters[category].delete(value);
        else filters[category].add(value);
        document.getElementById('clr-' + category).classList.toggle('active', filters[category].size > 0);
        updateUI();
    }
    function clearFilter(category) {
        filters[category].clear();
        document.getElementById('clr-' + category).classList.remove('active');
        updateUI();
    }
    function updateSlicerUI() {
        const uniques = { contractor: new Set(), year: new Set(), week: new Set(), date: new Set(), thirdMan: new Set() };
        routes.forEach(r => {
            uniques.contractor.add(r.contractor || '3 OF LIFE LLC');
            uniques.year.add(r.year || getYear(r.date));
            uniques.week.add(r.week || getWeekNumber(r.date).toString());
            uniques.date.add(r.date);
            uniques.thirdMan.add(r.third_man_status || 'None');
        });
        ['contractor', 'year', 'week', 'date', 'thirdMan'].forEach(cat => {
            const container = document.getElementById('slicer-' + cat);
            if (!container) return;
            container.innerHTML = '';
            Array.from(uniques[cat]).sort().forEach(val => {
                const el = document.createElement('div');
                el.className = 'slicer-item' + (filters[cat].has(val) ? ' selected' : '');
                el.textContent = val;
                el.onclick = () => toggleFilter(cat, val);
                container.appendChild(el);
            });
        });
    }

    function toggleNode(id) { expandedState[id] = !expandedState[id]; renderDailyReport(); }
    function toggleAllNodes(state) {
        routes.forEach(r => {
            const y = r.year || getYear(r.date);
            const w = r.week || getWeekNumber(r.date).toString();
            expandedState[`y-${y}`] = state;
            expandedState[`w-${y}-${w}`] = state;
        });
        renderDailyReport();
    }
    function getFilteredRoutes() {
        return routes.filter(r => {
            const y = r.year || getYear(r.date);
            const w = r.week || getWeekNumber(r.date).toString();
            const cont = r.contractor || '3 OF LIFE LLC';
            const tm = r.third_man_status || 'None';

            if(filters.contractor.size && !filters.contractor.has(cont)) return false;
            if(filters.year.size && !filters.year.has(y)) return false;
            if(filters.week.size && !filters.week.has(w)) return false;
            if(filters.date.size && !filters.date.has(r.date)) return false;
            if(filters.thirdMan.size && !filters.thirdMan.has(tm)) return false;
            return true;
        });
    }

    function sumObject() { return { routes:0, miles:0, manifest:0, pullbacks:0, loaded:0, incompletes:0, completed:0, milPay:0, fuelPay:0, thirdManPay:0, dedFlat:0, deductions:0, extra:0, totalPay:0 }; }
    function addSums(target, r) {
        target.routes++;
        target.miles += parseFloat(r.miles || 0);
        target.manifest += parseInt(r.manifest || 0);
        target.pullbacks += parseInt(r.pullbacks || 0);
        target.loaded += parseInt(r.loaded_stops || 0);
        target.incompletes += parseInt(r.incompletes || 0);
        target.completed += parseInt(r.completed_stops || 0);
        target.milPay += parseFloat(r.mileage_pay || 0);
        target.fuelPay += parseFloat(r.fuel_pay || 0);
        target.thirdManPay += (r.third_man_status === 'NYC' || r.third_man_status === 'Y') ? 125 : 0;
        target.dedFlat += parseFloat(r.dedicated_flat || 0);
        target.deductions += parseFloat(r.deductions || 0);
        target.extra += parseFloat(r.extra_pay || 0);
        target.totalPay += parseFloat(r.final_pay || 0);
    }

    function renderRowHTML(label, sums, cssClass, iconNodeId, isVisible) {
        if(!isVisible) return '';
        let iconHtml = iconNodeId ? `<span class="toggle-btn" onclick="toggleNode('${iconNodeId}')">${expandedState[iconNodeId] ? '-' : '+'}</span>` : '';
        return `
            <tr class="${cssClass}">
                <td style="text-align:left;">${iconHtml} ${label}</td>
                <td>${sums.routes}</td><td>${numFmt(sums.miles)}</td><td>${sums.manifest}</td>
                <td>${sums.pullbacks || ''}</td><td>${sums.loaded}</td><td>${sums.incompletes || ''}</td>
                <td>${sums.completed}</td><td>${formatMoney(sums.milPay)}</td><td>${formatMoney(sums.fuelPay)}</td>
                <td>${formatMoney(sums.thirdManPay)}</td><td>${sums.dedFlat > 0 ? formatMoney(sums.dedFlat) : ''}</td>
                <td>${sums.deductions > 0 ? formatMoney(sums.deductions) : ''}</td><td>${sums.extra > 0 ? formatMoney(sums.extra) : ''}</td>
                <td class="money">${formatMoney(sums.totalPay)}</td>
            </tr>`;
    }

    // --- VEHICLES ----------------------------------------------------------
    let vehicles = [];
    let vehicleServices = {}; // vehicle_id -> [{id, service_date, description, type}]
    let editingVehicleId = null;

    async function fetchVehiclesFromCloud() {
        try {
            const [vq, sq] = await Promise.all([
                supabaseClient.rpc('get_vehicles', { p_actor: currentUsername, p_company: currentCompany }),
                supabaseClient.rpc('get_vehicle_services', { p_actor: currentUsername, p_company: currentCompany })
            ]);
            if (vq.error) { console.error('get_vehicles:', vq.error); vehicles = []; }
            else vehicles = vq.data || [];
            const svc = {};
            if (sq.error) { console.error('get_vehicle_services:', sq.error); }
            else (sq.data || []).forEach(s => { (svc[s.vehicle_id] = svc[s.vehicle_id] || []).push(s); });
            vehicleServices = svc;
        } catch (e) { console.error('fetchVehiclesFromCloud:', e); }
        renderVehicles();
    }
