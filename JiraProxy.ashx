<%@ WebHandler Language="C#" Class="JiraProxy" %>

using System;
using System.Web;
using System.Net;
using System.Text;
using System.IO;
using System.Configuration;

public class JiraProxy : IHttpHandler {

    public void ProcessRequest (HttpContext context) {
        // Set Response Headers
        context.Response.ContentType = "application/json";
        
        // Handle CORS (if accessed from different domain, though usually same domain in IIS)
        context.Response.AddHeader("Access-Control-Allow-Origin", "*");

        // Configuration
        string jiraBaseUrl = "https://fibijira.fibi.corp/rest/api/2/search";
        string defaultJql = "type = Bug AND \"Assignee Management Hierarchy\" = T158429 AND status not in (Done, Cancelled) ORDER BY cf[11506] ASC";
        
        // Get Config Keys
        string email = ConfigurationManager.AppSettings["JiraEmail"];
        string apiKey = ConfigurationManager.AppSettings["JiraApiKey"];

        if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(apiKey)) {
            context.Response.StatusCode = 500;
            context.Response.Write("{\"error\": \"Missing Jira configuration (JiraEmail or JiraApiKey) in Web.config\"}");
            return;
        }

        // Get Query Params
        string jql = context.Request.QueryString["jql"];
        if (string.IsNullOrEmpty(jql)) {
            jql = defaultJql;
        }

        try {
            // Build Request
            string url = jiraBaseUrl + "?jql=" + HttpUtility.UrlEncode(jql);
            
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "GET";
            request.Accept = "application/json";

            // Basic Auth
            string auth = Convert.ToBase64String(Encoding.ASCII.GetBytes(email + ":" + apiKey));
            request.Headers.Add("Authorization", "Basic " + auth);

            // Get Response
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) {
                using (Stream stream = response.GetResponseStream()) {
                    using (StreamReader reader = new StreamReader(stream)) {
                        string json = reader.ReadToEnd();
                        context.Response.Write(json);
                    }
                }
            }
        }
        catch (WebException ex) {
            context.Response.StatusCode = 500;
            string message = ex.Message;
            
            // Try to read error body
            if (ex.Response != null) {
                using (Stream errorStream = ex.Response.GetResponseStream()) {
                    if (errorStream != null) {
                        using (StreamReader errorReader = new StreamReader(errorStream)) {
                            message = errorReader.ReadToEnd();
                        }
                    }
                }
            }
            
            // Use native serializer to avoid external dependencies (Newtonsoft)
            System.Web.Script.Serialization.JavaScriptSerializer serializer = new System.Web.Script.Serialization.JavaScriptSerializer();
            context.Response.Write("{\"error\": \"Jira Error\", \"details\": " + serializer.Serialize(message) + "}");
        }
        catch (Exception ex) {
            context.Response.StatusCode = 500;
            context.Response.Write("{\"error\": \"Server Error: " + ex.Message + "\"}");
        }
    }
 
    public bool IsReusable {
        get {
            return false;
        }
    }
}
