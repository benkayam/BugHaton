<%@ WebHandler Language="C#" Class="JiraProxy" %>

using System;
using System.Web;
using System.Net;
using System.Text;
using System.IO;
using System.Configuration;

public class JiraProxy : IHttpHandler {

    private void WriteLog(HttpContext context, string message) {
        try {
            string logFile = context.Server.MapPath("~/proxy_debug.log");
            string logEntry = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " - " + message + Environment.NewLine;
            File.AppendAllText(logFile, logEntry);
        } catch { 
            // Logging failed - likely permissions. Cannot do much here.
        }
    }

    public void ProcessRequest (HttpContext context) {
        WriteLog(context, "--- Request Started ---");

        // Set Response Headers
        context.Response.ContentType = "application/json";
        
        // Handle CORS (if accessed from different domain, though usually same domain in IIS)
        context.Response.AddHeader("Access-Control-Allow-Origin", "*");

        // Configuration
        string jiraBaseUrl = "https://fibijira.fibi.corp/rest/api/2/search";
        string defaultJql = "type = Bug AND \"Assignee Management Hierarchy\" = T158429 AND status not in (Done, Cancelled) ORDER BY cf[11506] ASC";
        
        WriteLog(context, "Target URL Base: " + jiraBaseUrl);

        // Get Config Keys
        string email = ConfigurationManager.AppSettings["JiraEmail"];
        string apiKey = ConfigurationManager.AppSettings["JiraApiKey"];

        if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(apiKey)) {
            WriteLog(context, "ERROR: Missing JiraEmail or JiraApiKey in Web.config");
            context.Response.StatusCode = 500;
            context.Response.Write("{\"error\": \"Missing Jira configuration\"}");
            return;
        }
        
        // Log masked credentials for verification
        WriteLog(context, "Config Found - Email: " + email + ", ApiKey Length: " + apiKey.Length);

        // Get Query Params
        string jql = context.Request.QueryString["jql"];
        if (string.IsNullOrEmpty(jql)) {
            jql = defaultJql;
        }

        try {
            // Build Request
            string url = jiraBaseUrl + "?jql=" + HttpUtility.UrlEncode(jql);
            WriteLog(context, "Full Request URL: " + url);
            
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Accept = "application/json";

            // Basic Auth
            string auth = Convert.ToBase64String(Encoding.ASCII.GetBytes(email + ":" + apiKey));
            request.Headers.Add("Authorization", "Basic " + auth);

            WriteLog(context, "Sending Request...");

            // Get Response
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) {
                WriteLog(context, "Response Status: " + response.StatusCode);
                using (Stream stream = response.GetResponseStream()) {
                    using (StreamReader reader = new StreamReader(stream)) {
                        string json = reader.ReadToEnd();
                        context.Response.Write(json);
                        WriteLog(context, "Success - Data sent to client");
                    }
                }
            }
        }
        catch (WebException ex) {
            string message = ex.Message;
            string remoteBody = "";
            bool isProtocolError = ex.Status == WebExceptionStatus.ProtocolError;
            
            // Try to read error body
            if (ex.Response != null) {
                using (Stream errorStream = ex.Response.GetResponseStream()) {
                    if (errorStream != null) {
                        using (StreamReader errorReader = new StreamReader(errorStream)) {
                            remoteBody = errorReader.ReadToEnd();
                        }
                    }
                }
            }

            WriteLog(context, "WebException: " + message);
            WriteLog(context, "Remote Body: " + remoteBody);

            context.Response.StatusCode = 500;
            if (isProtocolError && ex.Response is HttpWebResponse errorResponse) {
                 context.Response.StatusCode = (int)errorResponse.StatusCode;
            }
            
            // Use native serializer to avoid external dependencies (Newtonsoft)
            System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
            context.Response.Write("{\"error\": \"Jira Connection Failed\", \"details\": " + serializer.Serialize(message + " | " + remoteBody) + "}");
        }
        catch (Exception ex) {
            WriteLog(context, "General Exception: " + ex.ToString());
            context.Response.StatusCode = 500;
            System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
            context.Response.Write("{\"error\": \"Server Error\", \"details\": " + serializer.Serialize(ex.Message) + "}");
        }
    }
 
    public bool IsReusable {
        get {
            return false;
        }
    }
}
