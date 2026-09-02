function Test-FixedUpstashLauncherInput {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Url,
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Token
    )

    foreach ($value in @($Url, $Token)) {
        if (
            [string]::IsNullOrWhiteSpace($value) -or
            [char]::IsWhiteSpace($value[0]) -or
            [char]::IsWhiteSpace($value[$value.Length - 1]) -or
            $value.Contains("`r") -or
            $value.Contains("`n")
        ) {
            return $false
        }

        foreach ($assignment in @(
            "UPSTASH_REDIS_REST_URL=",
            "UPSTASH_REDIS_REST_TOKEN="
        )) {
            if (
                $value.IndexOf(
                    $assignment,
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -ge 0
            ) {
                return $false
            }
        }

        if ($value.Length -ge 2) {
            $first = $value[0]
            $last = $value[$value.Length - 1]
            if (
                ($first -eq '"' -and $last -eq '"') -or
                ($first -eq "'" -and $last -eq "'")
            ) {
                return $false
            }
        }
    }

    $parsedUrl = $null
    if (
        -not [System.Uri]::TryCreate(
            $Url,
            [System.UriKind]::Absolute,
            [ref]$parsedUrl
        ) -or
        $parsedUrl.Scheme -cne [System.Uri]::UriSchemeHttps -or
        -not [string]::IsNullOrEmpty($parsedUrl.UserInfo) -or
        -not [string]::IsNullOrEmpty($parsedUrl.Query) -or
        -not [string]::IsNullOrEmpty($parsedUrl.Fragment)
    ) {
        return $false
    }

    return $true
}
