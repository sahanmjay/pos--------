/**
 * RAMIS WEB API Service (Sri Lanka Inland Revenue Department - IRD)
 * ─────────────────────────────────────────────────────────────────
 * Handles:
 *  - Authentication via SSID & Password to acquire & cache JWT Bearer tokens
 *  - Automated token refresh on expiration or 401 Unauthorized
 *  - Schedule 1 (Output VAT on Taxable Supplies) payload validation & submission
 *  - Safe sandbox / mock mode for local testing without live IRD credentials
 *  - Dynamic runtime configuration (via Settings UI or environment variables)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const CONFIG_FILE = path.join(__dirname, '.data', 'ramis_config.json');

class RamisService {
  constructor(config = {}) {
    // Load persisted runtime config if available
    const saved = this._loadSavedConfig();

    this.baseUrl = config.baseUrl || saved.baseUrl || process.env.RAMIS_BASE_URL || 'https://ramis.ird.gov.lk/api/v1';
    this.ssid = config.ssid || saved.ssid || process.env.RAMIS_SSID || 'DEMO_SSID_102938475';
    this.password = config.password || saved.password || process.env.RAMIS_PASSWORD || 'DEMO_SECURE_PASS_2026';
    this.supplierTin = config.supplierTin || saved.supplierTin || process.env.RAMIS_SUPPLIER_TIN || '102938475';
    this.defaultPeriodCode = config.defaultPeriodCode || saved.defaultPeriodCode || '2610';
    
    // Mode: 'sandbox' (simulated), 'live' (official IRD gateway), or 'custom_sandbox' (IRD testbed)
    this.mode = config.mode || saved.mode || (process.env.RAMIS_SANDBOX === 'false' ? 'live' : 'sandbox');
    this.isSandbox = this.mode !== 'live';

    // Token Cache
    this.jwtToken = null;
    this.tokenExpiresAt = 0;
    this.isAuthenticating = null;
  }

  _loadSavedConfig() {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
      }
    } catch (e) {}
    return {};
  }

  _persistConfig() {
    try {
      const dir = path.dirname(CONFIG_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        baseUrl: this.baseUrl,
        ssid: this.ssid,
        password: this.password,
        supplierTin: this.supplierTin,
        defaultPeriodCode: this.defaultPeriodCode,
        mode: this.mode
      }, null, 2), 'utf8');
    } catch (e) {
      console.warn('⚠️ [RAMIS] Could not save config file:', e.message);
    }
  }

  /**
   * Update configuration dynamically from the POS Settings UI
   */
  updateConfig(cfg = {}) {
    if (cfg.baseUrl) this.baseUrl = cfg.baseUrl.trim();
    if (cfg.ssid) this.ssid = cfg.ssid.trim();
    if (cfg.password) this.password = cfg.password.trim();
    if (cfg.supplierTin) this.supplierTin = cfg.supplierTin.trim();
    if (cfg.defaultPeriodCode) this.defaultPeriodCode = cfg.defaultPeriodCode.trim();
    if (cfg.mode) {
      this.mode = cfg.mode;
      this.isSandbox = cfg.mode !== 'live';
    }

    // Invalidate cached token so next request acquires a new one with updated credentials
    this.jwtToken = null;
    this.tokenExpiresAt = 0;

    this._persistConfig();
    console.log(`⚙️ [RAMIS Config] Updated: Mode=${this.mode}, SSID=${this.ssid}, TIN=${this.supplierTin}, BaseURL=${this.baseUrl}`);
    return this.getConfig();
  }

  /**
   * Get public config (with masked password)
   */
  getConfig() {
    return {
      baseUrl: this.baseUrl,
      ssid: this.ssid,
      hasPassword: Boolean(this.password && this.password.length > 0),
      maskedPassword: this.password ? '••••••••' : '',
      supplierTin: this.supplierTin,
      defaultPeriodCode: this.defaultPeriodCode,
      mode: this.mode,
      isSandbox: this.isSandbox,
      isTokenActive: Boolean(this.jwtToken && this.tokenExpiresAt > Date.now()),
      tokenExpiresAt: this.tokenExpiresAt ? new Date(this.tokenExpiresAt).toISOString() : null
    };
  }

  /**
   * Test Authentication against the IRD endpoint with given or active credentials
   */
  async testAuth(customCreds = null) {
    const ssid = (customCreds && customCreds.ssid) || this.ssid;
    const password = (customCreds && customCreds.password) || this.password;
    const baseUrl = (customCreds && customCreds.baseUrl) || this.baseUrl;
    const mode = (customCreds && customCreds.mode) || this.mode;

    console.log(`🧪 [RAMIS Test Auth] Testing connection for SSID: ${ssid} (Mode: ${mode})...`);

    if (mode === 'sandbox' && (!ssid || ssid.startsWith('DEMO_'))) {
      await new Promise(r => setTimeout(r, 300));
      return {
        success: true,
        mode: 'sandbox',
        message: 'Sandbox Authentication Successful! Simulated JWT Bearer token acquired.',
        token: `simulated_ramis_jwt_${Date.now()}`,
        expiresIn: 3600,
        testedAt: new Date().toISOString()
      };
    }

    // Connect to actual IRD Auth endpoint
    try {
      const response = await this._makeRequest(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({ ssid, password })
      });

      if (!response || !response.token) {
        throw new Error('Invalid authentication response from IRD server. Token not returned.');
      }

      return {
        success: true,
        mode: 'live',
        message: 'Connected to Sri Lanka IRD Gateway! Valid JWT token received.',
        token: response.token.substring(0, 15) + '...',
        expiresIn: response.expiresIn || 3600,
        testedAt: new Date().toISOString()
      };
    } catch (err) {
      return {
        success: false,
        mode,
        error: err.message || 'Authentication failed. Please verify your SSID and Password with IRD.'
      };
    }
  }

  /**
   * Acquire a valid JWT token from RAMIS Authentication endpoint.
   */
  async getAuthToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.jwtToken && this.tokenExpiresAt > now + 60000) {
      return this.jwtToken;
    }

    if (this.isAuthenticating) {
      return this.isAuthenticating;
    }

    this.isAuthenticating = (async () => {
      try {
        console.log(`🔑 [RAMIS Auth] Requesting JWT token for SSID: ${this.ssid}...`);

        if (this.isSandbox && (!this.ssid || this.ssid.startsWith('DEMO_'))) {
          this.jwtToken = `simulated_ramis_jwt_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          this.tokenExpiresAt = Date.now() + (3600 * 1000);
          return this.jwtToken;
        }

        const response = await this._makeRequest(`${this.baseUrl}/auth/token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({ ssid: this.ssid, password: this.password })
        });

        if (!response || !response.token) {
          throw new Error(`RAMIS Auth failed: Invalid response (${JSON.stringify(response)})`);
        }

        this.jwtToken = response.token;
        const expiresInSec = response.expiresIn || 3600;
        this.tokenExpiresAt = Date.now() + (expiresInSec * 1000);

        console.log(`✅ [RAMIS Auth] Valid token acquired. Expires at: ${new Date(this.tokenExpiresAt).toLocaleTimeString()}`);
        return this.jwtToken;
      } finally {
        this.isAuthenticating = null;
      }
    })();

    return this.isAuthenticating;
  }

  /**
   * Submit an invoice to RAMIS Schedule 1 (Output VAT on Taxable Supplies)
   */
  async submitSchedule1(invoice) {
    const validationErrors = this.validateSchedule1Payload(invoice);
    if (validationErrors.length > 0) {
      throw new Error(`RAMIS Schedule 1 Validation Error: ${validationErrors.join(', ')}`);
    }

    const supplierTin = invoice.supplierTin || this.supplierTin;
    const periodCode = invoice.periodCode || this.defaultPeriodCode || '2610';

    const ramisPayload = {
      scheduleType: 'SCHEDULE_1_OUTPUT_VAT',
      taxInvoiceNumber: String(invoice.taxInvoiceNo).trim(),
      invoiceDate: String(invoice.invoiceDate).trim(), // YYYY-MM-DD
      periodCode: String(periodCode).trim(),          // Page 3: e.g. 2540, 2610
      supplierTIN: String(supplierTin).trim(),
      purchaserTIN: invoice.purchaserTin ? String(invoice.purchaserTin).trim() : null,
      purchaserName: invoice.purchaserName || null,
      taxableSupplyValue: Number(Number(invoice.valueOfSupply).toFixed(2)),
      vatCharged: Number(Number(invoice.vatAmount).toFixed(2)),
      totalInvoiceValue: Number(Number(invoice.totalAmount || (invoice.valueOfSupply + invoice.vatAmount)).toFixed(2)),
      submissionTimestamp: new Date().toISOString()
    };

    console.log(`📤 [RAMIS Submission] Submitting Invoice ${ramisPayload.taxInvoiceNumber} to Schedule 1...`);

    let token = await this.getAuthToken();

    if (this.isSandbox && (!this.ssid || this.ssid.startsWith('DEMO_'))) {
      await new Promise(r => setTimeout(r, 250));
      const ramisRef = `RAMIS-S1-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      console.log(`✅ [RAMIS IRD] [SANDBOX SUCCESS] Invoice ${ramisPayload.taxInvoiceNumber} queued into MSMQ. Ref: ${ramisRef}`);
      return {
        success: true,
        ramisReference: ramisRef,
        status: 'ACCEPTED_BY_MSMQ',
        message: 'Invoice successfully received by IRD RAMIS gateway and queued for Schedule 1 processing.',
        timestamp: new Date().toISOString(),
        payload: ramisPayload
      };
    }

    try {
      const response = await this._makeRequest(`${this.baseUrl}/vat/schedule1/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(ramisPayload)
      });

      return {
        success: true,
        ramisReference: response.referenceNumber || response.id || `RAMIS-${Date.now()}`,
        status: response.status || 'ACCEPTED_BY_MSMQ',
        data: response
      };
    } catch (err) {
      if (err.statusCode === 401) {
        console.warn(`🔄 [RAMIS] 401 encountered. Refreshing token and retrying...`);
        token = await this.getAuthToken(true);
        const retryResponse = await this._makeRequest(`${this.baseUrl}/vat/schedule1/submit`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify(ramisPayload)
        });
        return {
          success: true,
          ramisReference: retryResponse.referenceNumber || retryResponse.id,
          status: retryResponse.status || 'ACCEPTED_BY_MSMQ',
          data: retryResponse
        };
      }
      throw err;
    }
  }

  validateSchedule1Payload(inv) {
    const errors = [];
    if (!inv.taxInvoiceNo) errors.push('taxInvoiceNo is required');
    if (!inv.invoiceDate || !/^\d{4}-\d{2}-\d{2}$/.test(inv.invoiceDate)) errors.push('invoiceDate must be in YYYY-MM-DD format');
    if (!inv.supplierTin && !this.supplierTin) errors.push('supplierTin is required');
    if (typeof inv.valueOfSupply !== 'number' || isNaN(inv.valueOfSupply) || inv.valueOfSupply < 0) {
      errors.push('valueOfSupply must be a non-negative number');
    }
    if (typeof inv.vatAmount !== 'number' || isNaN(inv.vatAmount) || inv.vatAmount < 0) {
      errors.push('vatAmount must be a non-negative number');
    }
    return errors;
  }

  _makeRequest(urlStr, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const reqOptions = {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ''),
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 12000
      };

      const req = lib.request(reqOptions, (res) => {
        let rawData = '';
        res.on('data', chunk => rawData += chunk);
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(rawData);
          } catch (e) {
            parsed = { rawText: rawData };
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const error = new Error(`RAMIS API Error (${res.statusCode}): ${parsed.message || rawData || res.statusMessage}`);
            error.statusCode = res.statusCode;
            error.response = parsed;
            reject(error);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`RAMIS API request timed out after ${reqOptions.timeout}ms`);
        err.code = 'ETIMEDOUT';
        reject(err);
      });

      req.on('error', (err) => reject(err));

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}

module.exports = RamisService;
