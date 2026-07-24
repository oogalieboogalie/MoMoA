/**
 * Copyright 2026 Reto Meier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { GoogleAuth } from 'google-auth-library';

/**
 * Fetches an OIDC Identity Token for authenticating with a protected Cloud Run service.
 * @param serviceUrl The URL of your deployed Cloud Run proxy
 * @returns The raw JWT token string
 */
export async function getCloudRunIdentityToken(serviceUrl: string): Promise<string> {
    const auth = new GoogleAuth();
    
    // The "audience" is the base URL of the Cloud Run service
    const targetAudience = serviceUrl.replace(/\/$/, ""); 
    
    try {
        const client = await auth.getIdTokenClient(targetAudience);
        
        // Directly fetch the raw JWT token string, bypassing the headers completely
        const idToken = await client.idTokenProvider.fetchIdToken(targetAudience);
        
        if (!idToken || typeof idToken !== 'string') {
            throw new Error("Failed to fetch ID token from GoogleAuth client.");
        }
        
        return idToken;
    } catch (error) {
        console.error("Error generating Identity Token:", error);
        throw error;
    }
}