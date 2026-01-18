using System.Net.Http.Headers;
using System.Text;
using Microsoft.AspNetCore.Mvc;

var builder = WebApplication.CreateBuilder(args);

// Add services to the container.
builder.Services.AddHttpClient();

var app = builder.Build();

// Configure the HTTP request pipeline.
app.UseDefaultFiles();
app.UseStaticFiles();

// Jira Proxy Endpoint
app.MapGet("/api/jira", async (IConfiguration config, IHttpClientFactory httpClientFactory, [FromQuery] string? jql) =>
{
    var jiraUrl = "https://fibijira.fibi.corp/rest/api/2/search";
    var defaultJql = "type = Bug AND \"Assignee Management Hierarchy\" = T158429 AND status not in (Done, Cancelled) ORDER BY cf[11506] ASC";
    
    // Use provided JQL or default
    var queryJql = !string.IsNullOrEmpty(jql) ? jql : defaultJql;

    var email = config["Jira:Email"];
    var apiKey = config["Jira:ApiKey"];

    if (string.IsNullOrEmpty(email) || string.IsNullOrEmpty(apiKey))
    {
        return Results.Problem("Missing Jira configuration (Email or ApiKey)", statusCode: 500);
    }

    var client = httpClientFactory.CreateClient();
    
    // Create Basic Auth Header
    var authString = Convert.ToBase64String(Encoding.ASCII.GetBytes($"{email}:{apiKey}"));
    client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", authString);
    client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

    try 
    {
        // Build URL with params
        var url = $"{jiraUrl}?jql={Uri.EscapeDataString(queryJql)}";
        
        var response = await client.GetAsync(url);
        
        if (!response.IsSuccessStatusCode)
        {
            var errorContent = await response.Content.ReadAsStringAsync();
            return Results.Problem($"Jira Error: {response.ReasonPhrase}. Details: {errorContent}", statusCode: (int)response.StatusCode);
        }

        var content = await response.Content.ReadAsStringAsync();
        return Results.Content(content, "application/json");
    }
    catch (Exception ex)
    {
        return Results.Problem($"Server Error: {ex.Message}", statusCode: 500);
    }
});

app.Run();
